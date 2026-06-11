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
      activity_events: {
        Row: {
          created_at: string
          event_type: string
          id: number
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type?: string
          id?: number
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: number
          user_id?: string
        }
        Relationships: []
      }
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
          category: string | null
          cover_image_url: string | null
          created_at: string
          file_name: string
          id: string
          page_count: number
          tags: string[]
          title: string
          user_id: string | null
        }
        Insert: {
          category?: string | null
          cover_image_url?: string | null
          created_at?: string
          file_name: string
          id?: string
          page_count?: number
          tags?: string[]
          title: string
          user_id?: string | null
        }
        Update: {
          category?: string | null
          cover_image_url?: string | null
          created_at?: string
          file_name?: string
          id?: string
          page_count?: number
          tags?: string[]
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
      consolidation_queue: {
        Row: {
          created_at: string
          entry_id: string | null
          id: string
          pending_data: Json | null
          priority: number
          processed_at: string | null
          reason: string
          user_id: string
        }
        Insert: {
          created_at?: string
          entry_id?: string | null
          id?: string
          pending_data?: Json | null
          priority?: number
          processed_at?: string | null
          reason: string
          user_id: string
        }
        Update: {
          created_at?: string
          entry_id?: string | null
          id?: string
          pending_data?: Json | null
          priority?: number
          processed_at?: string | null
          reason?: string
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
      entry_bridges: {
        Row: {
          created_at: string
          entry_id: string
          id: string
          user_id: string
          wiki_id: string
        }
        Insert: {
          created_at?: string
          entry_id: string
          id?: string
          user_id: string
          wiki_id: string
        }
        Update: {
          created_at?: string
          entry_id?: string
          id?: string
          user_id?: string
          wiki_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entry_bridges_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entry_bridges_wiki_id_fkey"
            columns: ["wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
      }
      episodic_log: {
        Row: {
          created_at: string
          entry_count: number
          id: string
          key_facts: Json
          session_id: string
          summary: string | null
          user_id: string
          wiki_id: string | null
        }
        Insert: {
          created_at?: string
          entry_count?: number
          id?: string
          key_facts?: Json
          session_id: string
          summary?: string | null
          user_id: string
          wiki_id?: string | null
        }
        Update: {
          created_at?: string
          entry_count?: number
          id?: string
          key_facts?: Json
          session_id?: string
          summary?: string | null
          user_id?: string
          wiki_id?: string | null
        }
        Relationships: []
      }
      incubator_entries: {
        Row: {
          cluster_id: string | null
          created_at: string
          embedding: unknown
          entry_id: string
          expires_at: string
          id: string
          reason: string
          status: string
          user_id: string
        }
        Insert: {
          cluster_id?: string | null
          created_at?: string
          embedding: unknown
          entry_id: string
          expires_at?: string
          id?: string
          reason?: string
          status?: string
          user_id: string
        }
        Update: {
          cluster_id?: string | null
          created_at?: string
          embedding?: unknown
          entry_id?: string
          expires_at?: string
          id?: string
          reason?: string
          status?: string
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
          embedding_v2: unknown
          entry_type: string
          folder: string
          id: string
          is_index: boolean
          linked_wiki_id: string | null
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
          wiki_id: string | null
        }
        Insert: {
          atomicity_warning?: string | null
          confidence?: number
          content?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          embedding_v2?: unknown
          entry_type?: string
          folder?: string
          id?: string
          is_index?: boolean
          linked_wiki_id?: string | null
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
          wiki_id?: string | null
        }
        Update: {
          atomicity_warning?: string | null
          confidence?: number
          content?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          embedding_v2?: unknown
          entry_type?: string
          folder?: string
          id?: string
          is_index?: boolean
          linked_wiki_id?: string | null
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
          wiki_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_entries_linked_wiki_id_fkey"
            columns: ["linked_wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_entries_source_book_id_fkey"
            columns: ["source_book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_entries_wiki_id_fkey"
            columns: ["wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
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
      reroute_suggestions: {
        Row: {
          created_at: string
          entry_id: string
          from_wiki_id: string
          id: string
          reason: string
          status: string
          to_wiki_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          entry_id: string
          from_wiki_id: string
          id?: string
          reason?: string
          status?: string
          to_wiki_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          entry_id?: string
          from_wiki_id?: string
          id?: string
          reason?: string
          status?: string
          to_wiki_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reroute_suggestions_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reroute_suggestions_from_wiki_id_fkey"
            columns: ["from_wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reroute_suggestions_to_wiki_id_fkey"
            columns: ["to_wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
      }
      routing_decisions: {
        Row: {
          created_at: string
          entry_id: string
          final_wiki_id: string | null
          id: string
          novelty: number | null
          proposed_action: string
          proposed_wiki_id: string | null
          s_2nd: number | null
          s_active: number | null
          s_max: number | null
          user_corrected: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          entry_id: string
          final_wiki_id?: string | null
          id?: string
          novelty?: number | null
          proposed_action: string
          proposed_wiki_id?: string | null
          s_2nd?: number | null
          s_active?: number | null
          s_max?: number | null
          user_corrected?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          entry_id?: string
          final_wiki_id?: string | null
          id?: string
          novelty?: number | null
          proposed_action?: string
          proposed_wiki_id?: string | null
          s_2nd?: number | null
          s_active?: number | null
          s_max?: number | null
          user_corrected?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routing_decisions_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "routing_decisions_final_wiki_id_fkey"
            columns: ["final_wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "routing_decisions_proposed_wiki_id_fkey"
            columns: ["proposed_wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
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
      subscribers: {
        Row: {
          billing_issue: boolean
          created_at: string
          email: string
          id: string
          plan: string
          stripe_customer_id: string | null
          subscribed: boolean
          subscription_end: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          billing_issue?: boolean
          created_at?: string
          email: string
          id?: string
          plan?: string
          stripe_customer_id?: string | null
          subscribed?: boolean
          subscription_end?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          billing_issue?: boolean
          created_at?: string
          email?: string
          id?: string
          plan?: string
          stripe_customer_id?: string | null
          subscribed?: boolean
          subscription_end?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: number
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: number
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          active_wiki_id: string | null
          auto_read_replies: boolean
          burplexity_api_token: string | null
          created_at: string
          custom_system_prompt: string | null
          deep_research_model: string | null
          hands_free_tts_rate: number
          id: string
          inworld_api_key: string
          inworld_enabled: boolean
          inworld_voice_id: string
          is_recording_mode: boolean
          openrouter_api_key: string | null
          saved_models: Json | null
          selected_model: string | null
          smart_filing_enabled: boolean
          tts_rate: number
          updated_at: string
          user_id: string
          voice_model: string | null
          wiki_model: string | null
        }
        Insert: {
          active_wiki_id?: string | null
          auto_read_replies?: boolean
          burplexity_api_token?: string | null
          created_at?: string
          custom_system_prompt?: string | null
          deep_research_model?: string | null
          hands_free_tts_rate?: number
          id?: string
          inworld_api_key?: string
          inworld_enabled?: boolean
          inworld_voice_id?: string
          is_recording_mode?: boolean
          openrouter_api_key?: string | null
          saved_models?: Json | null
          selected_model?: string | null
          smart_filing_enabled?: boolean
          tts_rate?: number
          updated_at?: string
          user_id: string
          voice_model?: string | null
          wiki_model?: string | null
        }
        Update: {
          active_wiki_id?: string | null
          auto_read_replies?: boolean
          burplexity_api_token?: string | null
          created_at?: string
          custom_system_prompt?: string | null
          deep_research_model?: string | null
          hands_free_tts_rate?: number
          id?: string
          inworld_api_key?: string
          inworld_enabled?: boolean
          inworld_voice_id?: string
          is_recording_mode?: boolean
          openrouter_api_key?: string | null
          saved_models?: Json | null
          selected_model?: string | null
          smart_filing_enabled?: boolean
          tts_rate?: number
          updated_at?: string
          user_id?: string
          voice_model?: string | null
          wiki_model?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_settings_active_wiki_id_fkey"
            columns: ["active_wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
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
      wiki_centroids: {
        Row: {
          centroid: unknown
          confident_threshold: number
          entry_count: number
          last_recomputed_at: string
          novelty_threshold: number
          user_id: string
          wiki_id: string
        }
        Insert: {
          centroid: unknown
          confident_threshold?: number
          entry_count?: number
          last_recomputed_at?: string
          novelty_threshold?: number
          user_id: string
          wiki_id: string
        }
        Update: {
          centroid?: unknown
          confident_threshold?: number
          entry_count?: number
          last_recomputed_at?: string
          novelty_threshold?: number
          user_id?: string
          wiki_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wiki_centroids_wiki_id_fkey"
            columns: ["wiki_id"]
            isOneToOne: true
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
      }
      wiki_health_alerts: {
        Row: {
          created_at: string
          id: string
          kind: string
          rationale: string
          status: string
          suggestion: Json
          updated_at: string
          user_id: string
          wiki_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          rationale?: string
          status?: string
          suggestion?: Json
          updated_at?: string
          user_id: string
          wiki_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          rationale?: string
          status?: string
          suggestion?: Json
          updated_at?: string
          user_id?: string
          wiki_id?: string
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
      wiki_proposals: {
        Row: {
          created_at: string
          id: string
          member_entry_ids: string[]
          proposed_name: string
          rationale: string
          sample_titles: string[]
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          member_entry_ids?: string[]
          proposed_name: string
          rationale?: string
          sample_titles?: string[]
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          member_entry_ids?: string[]
          proposed_name?: string
          rationale?: string
          sample_titles?: string[]
          status?: string
          updated_at?: string
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
      wikis: {
        Row: {
          cover_color: string
          created_at: string
          description: string
          id: string
          is_default: boolean
          is_meta: boolean
          last_loaded_at: string | null
          name: string
          tags: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          cover_color?: string
          created_at?: string
          description?: string
          id?: string
          is_default?: boolean
          is_meta?: boolean
          last_loaded_at?: string | null
          name: string
          tags?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          cover_color?: string
          created_at?: string
          description?: string
          id?: string
          is_default?: boolean
          is_meta?: boolean
          last_loaded_at?: string | null
          name?: string
          tags?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      workspace_items: {
        Row: {
          content: string
          created_at: string
          id: string
          kind: string
          meta: Json | null
          saved_to_library: boolean
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content?: string
          created_at?: string
          id?: string
          kind: string
          meta?: Json | null
          saved_to_library?: boolean
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          kind?: string
          meta?: Json | null
          saved_to_library?: boolean
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_delete_user: { Args: { _user_id: string }; Returns: undefined }
      admin_list_users: {
        Args: never
        Returns: {
          burplexity_api_token: string
          created_at: string
          deep_research_model: string
          email: string
          id: string
          inworld_api_key: string
          is_admin: boolean
          last_seen: string
          last_sign_in_at: string
          openrouter_api_key: string
          selected_model: string
          visits_today: number
          visits_total: number
          voice_model: string
          wiki_model: string
        }[]
      }
      admin_update_user_settings: {
        Args: {
          _burplexity_api_token?: string
          _deep_research_model?: string
          _inworld_api_key?: string
          _openrouter_api_key?: string
          _selected_model?: string
          _user_id: string
          _voice_model?: string
          _wiki_model?: string
        }
        Returns: undefined
      }
      admin_user_daily_visits: {
        Args: { _days?: number; _user_id: string }
        Returns: {
          day: string
          visits: number
        }[]
      }
      conflicts_for_wiki: {
        Args: { target_wiki_id: string }
        Returns: {
          created_at: string
          entry_a: string
          entry_b: string
          id: string
          kind: string
          rationale: string
          status: string
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "knowledge_conflicts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      consolidation_queue_for_wiki: {
        Args: { target_wiki_id: string }
        Returns: {
          created_at: string
          entry_id: string | null
          id: string
          pending_data: Json | null
          priority: number
          processed_at: string | null
          reason: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "consolidation_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      entries_for_wiki: {
        Args: { target_wiki_id: string }
        Returns: {
          atomicity_warning: string | null
          confidence: number
          content: string
          created_at: string
          embedding: string | null
          embedding_model: string | null
          embedding_v2: unknown
          entry_type: string
          folder: string
          id: string
          is_index: boolean
          linked_wiki_id: string | null
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
          wiki_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "knowledge_entries"
          isOneToOne: false
          isSetofReturn: true
        }
      }
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
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
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
      is_admin: { Args: never; Returns: boolean }
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
      match_knowledge_entries: {
        Args: {
          filter_wiki_ids?: string[]
          match_count: number
          match_threshold: number
          query_embedding: unknown
        }
        Returns: {
          confidence: number
          content: string
          entry_type: string
          id: string
          similarity: number
          source_book_id: string
          tags: string[]
          title: string
          wiki_id: string
        }[]
      }
      memory_graph_for_wiki: {
        Args: { target_wiki_id: string }
        Returns: {
          created_at: string
          created_by: string
          edge_class: string | null
          id: string
          relationship: string
          source_entry_id: string
          target_entry_id: string
          user_id: string
          weight: number
        }[]
        SetofOptions: {
          from: "*"
          to: "memory_graph"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      score_entry_against_wikis: {
        Args: { query_embedding: unknown }
        Returns: {
          confident_threshold: number
          novelty_threshold: number
          similarity: number
          wiki_id: string
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "user"
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
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
