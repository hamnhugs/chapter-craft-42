export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          id: string
          key_value: string
          label: string
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_value: string
          label?: string
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          key_value?: string
          label?: string
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      books: {
        Row: {
          cover_image_url: string | null
          created_at: string
          file_name: string
          id: string
          page_count: number
          title: string
          user_id: string | null
        }
        Insert: {
          cover_image_url?: string | null
          created_at?: string
          file_name: string
          id?: string
          page_count?: number
          title: string
          user_id?: string | null
        }
        Update: {
          cover_image_url?: string | null
          created_at?: string
          file_name?: string
          id?: string
          page_count?: number
          title?: string
          user_id?: string | null
        }
        Relationships: []
      }
      chapters: {
        Row: {
          book_id: string
          created_at: string
          end_page: number
          id: string
          name: string
          start_page: number
          text_content: string
          user_id: string | null
        }
        Insert: {
          book_id: string
          created_at?: string
          end_page: number
          id?: string
          name: string
          start_page: number
          text_content?: string
          user_id?: string | null
        }
        Update: {
          book_id?: string
          created_at?: string
          end_page?: number
          id?: string
          name?: string
          start_page?: number
          text_content?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chapters_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          book_id: string | null
          content: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          book_id?: string | null
          content?: string
          created_at?: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          book_id?: string | null
          content?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      conversation_memory: {
        Row: {
          id: string
          key_facts: Json
          summary: string
          total_conversations: number
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          key_facts?: Json
          summary?: string
          total_conversations?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          key_facts?: Json
          summary?: string
          total_conversations?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      knowledge_conflicts: {
        Row: {
          created_at: string
          entry_a: string
          entry_b: string
          id: string
          kind: string
          rationale: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          entry_a: string
          entry_b: string
          id?: string
          kind?: string
          rationale?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          entry_a?: string
          entry_b?: string
          id?: string
          kind?: string
          rationale?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      knowledge_entries: {
        Row: {
          atomicity_warning: string | null
          confidence: number
          content: string
          created_at: string
          embedding: string | null
          embedding_model: string | null
          entry_type: string
          folder: string
          id: string
          is_index: boolean
          maturity: string
          pending_changes: Json
          source_book_id: string | null
          subject: string | null
          tags: string[]
          title: string
          tsv: unknown
          updated_at: string
          user_id: string
          valid_from: string | null
          valid_to: string | null
        }
        Insert: {
          atomicity_warning?: string | null
          confidence?: number
          content?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          entry_type?: string
          folder?: string
          id?: string
          is_index?: boolean
          maturity?: string
          pending_changes?: Json
          source_book_id?: string | null
          subject?: string | null
          tags?: string[]
          title: string
          tsv?: unknown
          updated_at?: string
          user_id: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Update: {
          atomicity_warning?: string | null
          confidence?: number
          content?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          entry_type?: string
          folder?: string
          id?: string
          is_index?: boolean
          maturity?: string
          pending_changes?: Json
          source_book_id?: string | null
          subject?: string | null
          tags?: string[]
          title?: string
          tsv?: unknown
          updated_at?: string
          user_id?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_entries_source_book_id_fkey"
            columns: ["source_book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_graph: {
        Row: {
          created_at: string
          created_by: string
          edge_class: string | null
          id: string
          relationship: string
          source_entry_id: string
          target_entry_id: string
          user_id: string
          weight: number
        }
        Insert: {
          created_at?: string
          created_by?: string
          edge_class?: string | null
          id?: string
          relationship?: string
          source_entry_id: string
          target_entry_id: string
          user_id: string
          weight?: number
        }
        Update: {
          created_at?: string
          created_by?: string
          edge_class?: string | null
          id?: string
          relationship?: string
          source_entry_id?: string
          target_entry_id?: string
          user_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "memory_graph_source_entry_id_fkey"
            columns: ["source_entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_graph_target_entry_id_fkey"
            columns: ["target_entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          book_id: string | null
          content: string
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          book_id?: string | null
          content?: string
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          book_id?: string | null
          content?: string
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      prompt_presets: {
        Row: {
          body: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          scope: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          scope?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          scope?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      subject_progress: {
        Row: {
          id: string
          ingest_count: number
          interleave_unlocked_at: string | null
          started_at: string
          subject: string
          user_id: string
        }
        Insert: {
          id?: string
          ingest_count?: number
          interleave_unlocked_at?: string | null
          started_at?: string
          subject: string
          user_id: string
        }
        Update: {
          id?: string
          ingest_count?: number
          interleave_unlocked_at?: string | null
          started_at?: string
          subject?: string
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          auto_read_replies: boolean
          burplexity_api_token: string | null
          created_at: string
          custom_system_prompt: string | null
          deep_research_model: string | null
          id: string
          openrouter_api_key: string | null
          saved_models: Json | null
          selected_model: string | null
          tts_rate: number
          updated_at: string
          user_id: string
          wiki_model: string | null
        }
        Insert: {
          auto_read_replies?: boolean
          burplexity_api_token?: string | null
          created_at?: string
          custom_system_prompt?: string | null
          deep_research_model?: string | null
          id?: string
          openrouter_api_key?: string | null
          saved_models?: Json | null
          selected_model?: string | null
          tts_rate?: number
          updated_at?: string
          user_id: string
          wiki_model?: string | null
        }
        Update: {
          auto_read_replies?: boolean
          burplexity_api_token?: string | null
          created_at?: string
          custom_system_prompt?: string | null
          deep_research_model?: string | null
          id?: string
          openrouter_api_key?: string | null
          saved_models?: Json | null
          selected_model?: string | null
          tts_rate?: number
          updated_at?: string
          user_id?: string
          wiki_model?: string | null
        }
        Relationships: []
      }
      video_jobs: {
        Row: {
          created_at: string
          error: string | null
          id: string
          metadata: Json | null
          pdf_url: string | null
          status: string
          title: string | null
          transcript: string | null
          updated_at: string
          user_id: string
          video_url: string
          word_count: number | null
        }
        Insert: {
          created_at?: string
          error?: string | null
          id: string
          metadata?: Json | null
          pdf_url?: string | null
          status?: string
          title?: string | null
          transcript?: string | null
          updated_at?: string
          user_id: string
          video_url: string
          word_count?: number | null
        }
        Update: {
          created_at?: string
          error?: string | null
          id?: string
          metadata?: Json | null
          pdf_url?: string | null
          status?: string
          title?: string | null
          transcript?: string | null
          updated_at?: string
          user_id?: string
          video_url?: string
          word_count?: number | null
        }
        Relationships: []
      }
      wiki_log: {
        Row: {
          created_at: string
          details: Json
          entry_id: string | null
          id: string
          operation: string
          summary: string
          user_id: string
        }
        Insert: {
          created_at?: string
          details?: Json
          entry_id?: string | null
          id?: string
          operation: string
          summary?: string
          user_id: string
        }
        Update: {
          created_at?: string
          details?: Json
          entry_id?: string | null
          id?: string
          operation?: string
          summary?: string
          user_id?: string
        }
        Relationships: []
      }
      wiki_questions: {
        Row: {
          answer: string
          created_at: string
          entry_id: string
          id: string
          last_reviewed_at: string | null
          question: string
          times_reviewed: number
          user_id: string
        }
        Insert: {
          answer?: string
          created_at?: string
          entry_id: string
          id?: string
          last_reviewed_at?: string | null
          question: string
          times_reviewed?: number
          user_id: string
        }
        Update: {
          answer?: string
          created_at?: string
          entry_id?: string
          id?: string
          last_reviewed_at?: string | null
          question?: string
          times_reviewed?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wiki_questions_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      find_contradictions: {
        Args: { entry_id: string }
        Returns: {
          other_content: string
          other_id: string
          other_title: string
          relationship: string
        }[]
      }
      get_neighbors: {
        Args: { classes?: string[]; depth?: number; seed_ids: string[] }
        Returns: {
          content: string
          entry_id: string
          from_seed: string
          hop: number
          title: string
          via_edge_class: string
          via_relationship: string
        }[]
      }
      hybrid_search_knowledge: {
        Args: {
          full_text_weight?: number
          match_count?: number
          query_embedding: string
          query_text: string
          rrf_k?: number
          semantic_weight?: number
        }
        Returns: {
          content: string
          entry_type: string
          id: string
          score: number
          source_book_id: string
          tags: string[]
          title: string
        }[]
      }
      match_knowledge: {
        Args: {
          book_filter?: string
          match_count?: number
          query_embedding: string
        }
        Returns: {
          content: string
          entry_type: string
          id: string
          similarity: number
          source_book_id: string
          tags: string[]
          title: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
