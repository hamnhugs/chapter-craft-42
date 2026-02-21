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

    const url = new URL(req.url);
    const bookId = url.searchParams.get("book_id");
    const chapterId = url.searchParams.get("chapter_id");

    // GET /chapters-api — list all books
    // GET /chapters-api?book_id=xxx — list chapters for a book
    // GET /chapters-api?chapter_id=xxx — get a single chapter with text

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
      .select("id, title, file_name, page_count, created_at, chapters(id)")
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
