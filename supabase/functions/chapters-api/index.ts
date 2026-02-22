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
      .select("id")
      .eq("key_value", apiKey)
      .is("revoked_at", null)
      .maybeSingle();

    if (keyError || !keyRow) {
      return new Response(JSON.stringify({ error: "Invalid or revoked API key" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const bookId = url.searchParams.get("book_id");
    const chapterId = url.searchParams.get("chapter_id");

    // PATCH /chapters-api?book_id=xxx — update book title and/or cover image
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
