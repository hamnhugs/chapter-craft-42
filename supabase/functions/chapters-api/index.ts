import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Validate API key
    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing x-api-key header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: keyRow, error: keyError } = await supabase
      .from("api_keys")
      .select("id, user_id")
      .eq("key_value", apiKey)
      .is("revoked_at", null)
      .maybeSingle();

    if (keyError || !keyRow) {
      return new Response(JSON.stringify({ error: "Invalid or revoked API key" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const keyOwnerId = keyRow.user_id;
    const APP_URL = "https://chapter-craft-42.lovable.app";

    const url = new URL(req.url);
    const bookId = url.searchParams.get("book_id");
    const chapterId = url.searchParams.get("chapter_id");
    const action = url.searchParams.get("action");
    const noteId = url.searchParams.get("note_id");
    const resource = url.searchParams.get("resource"); // "notes" for notes endpoints

    // ─── NOTES ENDPOINTS ───
    if (resource === "notes") {
      // GET notes for a book
      if (req.method === "GET" && bookId) {
        const { data, error } = await supabase
          .from("notes")
          .select("id, title, content, created_at, updated_at")
          .eq("book_id", bookId)
          .eq("user_id", keyOwnerId)
          .order("created_at", { ascending: false });

        if (error) throw error;
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET single note
      if (req.method === "GET" && noteId) {
        const { data, error } = await supabase
          .from("notes")
          .select("*")
          .eq("id", noteId)
          .eq("user_id", keyOwnerId)
          .single();

        if (error) throw error;
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST — create a note
      if (req.method === "POST") {
        const body = await req.json();
        if (!body.book_id) {
          return new Response(JSON.stringify({ error: "book_id is required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data, error } = await supabase
          .from("notes")
          .insert({
            book_id: body.book_id,
            user_id: keyOwnerId,
            title: body.title || "",
            content: body.content || "",
          })
          .select()
          .single();

        if (error) throw error;
        return new Response(JSON.stringify(data), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PATCH — update a note
      if (req.method === "PATCH" && noteId) {
        const body = await req.json();
        const updates: Record<string, unknown> = {};
        if (body.title !== undefined) updates.title = body.title;
        if (body.content !== undefined) updates.content = body.content;
        updates.updated_at = new Date().toISOString();

        if (Object.keys(updates).length <= 1) {
          return new Response(JSON.stringify({ error: "Provide title or content to update" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { data, error } = await supabase
          .from("notes")
          .update(updates)
          .eq("id", noteId)
          .eq("user_id", keyOwnerId)
          .select()
          .single();

        if (error) throw error;
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE — delete a note
      if (req.method === "DELETE" && noteId) {
        const { error } = await supabase
          .from("notes")
          .delete()
          .eq("id", noteId)
          .eq("user_id", keyOwnerId);

        if (error) throw error;
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Invalid notes request. Provide book_id or note_id." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── BULK UPLOAD ENDPOINT ───
    if (resource === "upload" && req.method === "POST") {
      const contentType = req.headers.get("content-type") || "";
      if (!contentType.includes("multipart/form-data")) {
        return new Response(JSON.stringify({ error: "Content-Type must be multipart/form-data" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const formData = await req.formData();
      const results: Array<{ file_name: string; book_id?: string; error?: string }> = [];

      // Collect all file entries (supports multiple files)
      const files: File[] = [];
      for (const [_key, value] of formData.entries()) {
        if (value instanceof File && value.size > 0) {
          files.push(value);
        }
      }

      if (files.length === 0) {
        return new Response(JSON.stringify({ error: "No files provided. Send one or more file fields." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      for (const file of files) {
        try {
          const fileName = file.name;
          const title = fileName.replace(/\.[^/.]+$/, "");
          const bookId = crypto.randomUUID();

          // Create book record
          const { error: insertError } = await supabase
            .from("books")
            .insert({
              id: bookId,
              title,
              file_name: fileName,
              page_count: 0,
              user_id: keyOwnerId,
            });

          if (insertError) {
            results.push({ file_name: fileName, error: insertError.message });
            continue;
          }

          // Upload file to storage
          const ext = fileName.toLowerCase().split(".").pop() || "pdf";
          const storagePath = `${keyOwnerId}/${bookId}.${ext}`;

          const { error: uploadError } = await supabase.storage
            .from("book-pdfs")
            .upload(storagePath, file, {
              contentType: file.type || "application/octet-stream",
              upsert: true,
            });

          if (uploadError) {
            // Rollback: delete the book record
            await supabase.from("books").delete().eq("id", bookId);
            results.push({ file_name: fileName, error: uploadError.message });
            continue;
          }

          results.push({ file_name: fileName, book_id: bookId });
        } catch (e) {
          results.push({ file_name: file.name, error: e.message });
        }
      }

      const allOk = results.every((r) => !r.error);
      return new Response(JSON.stringify({ uploaded: results }), {
        status: allOk ? 201 : 207,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── EXISTING ENDPOINTS ───

    // GET /chapters-api?action=links
    if (req.method === "GET" && action === "links") {
      return new Response(JSON.stringify({
        login_url: `${APP_URL}/auth`,
        library_url: APP_URL,
        signup_url: `${APP_URL}/auth`,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PATCH /chapters-api?book_id=xxx
    if (req.method === "PATCH") {
      if (!bookId) {
        return new Response(JSON.stringify({ error: "book_id query param required for PATCH" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const body = await req.json();
      const updates: Record<string, unknown> = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.cover_image_url !== undefined) updates.cover_image_url = body.cover_image_url;

      if (Object.keys(updates).length === 0) {
        return new Response(JSON.stringify({ error: "Provide at least one field to update: title, cover_image_url" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data, error } = await supabase
        .from("books")
        .update(updates)
        .eq("id", bookId)
        .select()
        .single();

      if (error) throw error;
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET endpoints
    if (chapterId) {
      const { data, error } = await supabase
        .from("chapters")
        .select("*, books(title, file_name)")
        .eq("id", chapterId)
        .single();

      if (error) throw error;
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (bookId) {
      const { data, error } = await supabase
        .from("chapters")
        .select("id, name, start_page, end_page, text_content, created_at")
        .eq("book_id", bookId)
        .order("start_page");

      if (error) throw error;
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // List all books with chapter count
    const { data: books, error } = await supabase
      .from("books")
      .select("id, title, file_name, page_count, cover_image_url, created_at, chapters(id)")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const result = books?.map((b: any) => ({
      ...b,
      chapter_count: b.chapters?.length || 0,
      chapters: undefined,
    }));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
