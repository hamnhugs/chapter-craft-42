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
      knowledge_entries: {
        Row: {
          confidence: number
          content: string
          created_at: string
          entry_type: string
          id: string
          source_book_id: string | null
          tags: string[]
          title: string
          updated_at: string
          user_id: string
          valid_from: string | null
          valid_to: string | null
        }
        Insert: {
          confidence?: number
          content?: string
          created_at?: string
          entry_type?: string
          id?: string
          source_book_id?: string | null
          tags?: string[]
          title: string
          updated_at?: string
          user_id: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Update: {
          confidence?: number
          content?: string
          created_at?: string
          entry_type?: string
          id?: string
          source_book_id?: string | null
          tags?: string[]
          title?: string
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
          id: string
          relationship: string
          source_entry_id: string
          target_entry_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          relationship?: string
          source_entry_id: string
          target_entry_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          relationship?: string
          source_entry_id?: string
          target_entry_id?: string
          user_id?: string
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
          book_id: string
          content: string
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          book_id: string
          content?: string
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          book_id?: string
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
