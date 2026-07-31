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
      admin_audit_log: {
        Row: {
          action: string
          admin_id: string
          created_at: string
          detail: Json
          id: number
          target_id: string | null
          target_user_id: string | null
        }
        Insert: {
          action: string
          admin_id: string
          created_at?: string
          detail?: Json
          id?: number
          target_id?: string | null
          target_user_id?: string | null
        }
        Update: {
          action?: string
          admin_id?: string
          created_at?: string
          detail?: Json
          id?: number
          target_id?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      agent_tools: {
        Row: {
          code: string
          created_at: string
          description: string
          disabled_by_user: boolean
          entry_id: string | null
          fail_count: number
          id: string
          last_run_at: string | null
          manifest: Json
          name: string
          root_id: string | null
          run_count: number
          status: string
          superseded_by: string | null
          tests: Json
          user_id: string
          version: number
        }
        Insert: {
          code: string
          created_at?: string
          description?: string
          disabled_by_user?: boolean
          entry_id?: string | null
          fail_count?: number
          id?: string
          last_run_at?: string | null
          manifest?: Json
          name: string
          root_id?: string | null
          run_count?: number
          status?: string
          superseded_by?: string | null
          tests?: Json
          user_id: string
          version?: number
        }
        Update: {
          code?: string
          created_at?: string
          description?: string
          disabled_by_user?: boolean
          entry_id?: string | null
          fail_count?: number
          id?: string
          last_run_at?: string | null
          manifest?: Json
          name?: string
          root_id?: string | null
          run_count?: number
          status?: string
          superseded_by?: string | null
          tests?: Json
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_tools_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tools_root_id_fkey"
            columns: ["root_id"]
            isOneToOne: false
            referencedRelation: "agent_tools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tools_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "agent_tools"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_receipts: {
        Row: {
          acknowledged_at: string | null
          announcement_id: string
          dismissed_at: string | null
          policy_version: number
          seen_at: string
          user_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          announcement_id: string
          dismissed_at?: string | null
          policy_version?: number
          seen_at?: string
          user_id: string
        }
        Update: {
          acknowledged_at?: string | null
          announcement_id?: string
          dismissed_at?: string | null
          policy_version?: number
          seen_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_receipts_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          ends_at: string | null
          gif_alt: string
          gif_clickable: boolean
          gif_link_url: string | null
          gif_new_tab: boolean
          gif_url: string | null
          id: string
          is_active: boolean
          kind: string
          policy_version: number
          priority: number
          require_ack: boolean
          starts_at: string
          title: string
          updated_at: string
        }
        Insert: {
          body?: string
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          gif_alt?: string
          gif_clickable?: boolean
          gif_link_url?: string | null
          gif_new_tab?: boolean
          gif_url?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          policy_version?: number
          priority?: number
          require_ack?: boolean
          starts_at?: string
          title?: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          gif_alt?: string
          gif_clickable?: boolean
          gif_link_url?: string | null
          gif_new_tab?: boolean
          gif_url?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          policy_version?: number
          priority?: number
          require_ack?: boolean
          starts_at?: string
          title?: string
          updated_at?: string
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
      book_folders: {
        Row: {
          color: string | null
          created_at: string
          default_wiki_id: string | null
          id: string
          name: string
          parent_id: string | null
          sort_index: number
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          default_wiki_id?: string | null
          id?: string
          name: string
          parent_id?: string | null
          sort_index?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          default_wiki_id?: string | null
          id?: string
          name?: string
          parent_id?: string | null
          sort_index?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_folders_default_wiki_id_fkey"
            columns: ["default_wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "book_folders_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "book_folders"
            referencedColumns: ["id"]
          },
        ]
      }
      books: {
        Row: {
          category: string | null
          cover_image_url: string | null
          created_at: string
          file_name: string
          folder_id: string | null
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
          folder_id?: string | null
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
          folder_id?: string | null
          id?: string
          page_count?: number
          tags?: string[]
          title?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "books_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "book_folders"
            referencedColumns: ["id"]
          },
        ]
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
          images: Json | null
          role: string
          splats: Json | null
          user_id: string
          videos: Json | null
        }
        Insert: {
          book_id?: string | null
          content?: string
          created_at?: string
          id?: string
          images?: Json | null
          role: string
          splats?: Json | null
          user_id: string
          videos?: Json | null
        }
        Update: {
          book_id?: string | null
          content?: string
          created_at?: string
          id?: string
          images?: Json | null
          role?: string
          splats?: Json | null
          user_id?: string
          videos?: Json | null
        }
        Relationships: []
      }
      cleanup_flags: {
        Row: {
          confidence: number
          created_at: string
          dismissed_at: string | null
          entry_id: string
          flagged_by: string
          id: string
          note: string | null
          reason: string
          user_id: string
          wiki_id: string | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          dismissed_at?: string | null
          entry_id: string
          flagged_by?: string
          id?: string
          note?: string | null
          reason: string
          user_id: string
          wiki_id?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          dismissed_at?: string | null
          entry_id?: string
          flagged_by?: string
          id?: string
          note?: string | null
          reason?: string
          user_id?: string
          wiki_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cleanup_flags_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cleanup_flags_wiki_id_fkey"
            columns: ["wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
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
      image_attachments: {
        Row: {
          book_id: string | null
          caption: string
          created_at: string
          entry_id: string | null
          id: string
          kind: string
          mime: string
          model: string
          page: number | null
          phash: string | null
          prompt: string
          recall_last_session: string | null
          recall_last_shown_at: string | null
          recall_requested_count: number
          recall_shown_count: number
          recall_suppressed: boolean
          source_image_id: string | null
          storage_path: string
          user_id: string
        }
        Insert: {
          book_id?: string | null
          caption?: string
          created_at?: string
          entry_id?: string | null
          id?: string
          kind?: string
          mime?: string
          model?: string
          page?: number | null
          phash?: string | null
          prompt?: string
          recall_last_session?: string | null
          recall_last_shown_at?: string | null
          recall_requested_count?: number
          recall_shown_count?: number
          recall_suppressed?: boolean
          source_image_id?: string | null
          storage_path: string
          user_id: string
        }
        Update: {
          book_id?: string | null
          caption?: string
          created_at?: string
          entry_id?: string | null
          id?: string
          kind?: string
          mime?: string
          model?: string
          page?: number | null
          phash?: string | null
          prompt?: string
          recall_last_session?: string | null
          recall_last_shown_at?: string | null
          recall_requested_count?: number
          recall_shown_count?: number
          recall_suppressed?: boolean
          source_image_id?: string | null
          storage_path?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "image_attachments_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "image_attachments_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "image_attachments_source_image_id_fkey"
            columns: ["source_image_id"]
            isOneToOne: false
            referencedRelation: "image_attachments"
            referencedColumns: ["id"]
          },
        ]
      }
      image_memories: {
        Row: {
          caption: string | null
          created_at: string
          embedding_v2: unknown
          height: number | null
          id: string
          mime_type: string | null
          ocr_text: string | null
          source: string
          source_message_id: string | null
          storage_path: string
          tags: string[] | null
          tsv: unknown
          updated_at: string
          user_id: string
          width: number | null
          wiki_id: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string
          embedding_v2?: unknown
          height?: number | null
          id?: string
          mime_type?: string | null
          ocr_text?: string | null
          source?: string
          source_message_id?: string | null
          storage_path: string
          tags?: string[] | null
          tsv?: unknown
          updated_at?: string
          user_id: string
          width?: number | null
          wiki_id?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string
          embedding_v2?: unknown
          height?: number | null
          id?: string
          mime_type?: string | null
          ocr_text?: string | null
          source?: string
          source_message_id?: string | null
          storage_path?: string
          tags?: string[] | null
          tsv?: unknown
          updated_at?: string
          user_id?: string
          width?: number | null
          wiki_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "image_memories_wiki_id_fkey"
            columns: ["wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
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
      ingest_jobs: {
        Row: {
          attempts: number
          book_id: string | null
          created_at: string
          error: string | null
          finished_at: string | null
          folder_id: string | null
          id: string
          model: string | null
          progress: string | null
          result: Json | null
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
          wiki_id: string | null
        }
        Insert: {
          attempts?: number
          book_id?: string | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          folder_id?: string | null
          id?: string
          model?: string | null
          progress?: string | null
          result?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
          wiki_id?: string | null
        }
        Update: {
          attempts?: number
          book_id?: string | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          folder_id?: string | null
          id?: string
          model?: string | null
          progress?: string | null
          result?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          wiki_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingest_jobs_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingest_jobs_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "book_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingest_jobs_wiki_id_fkey"
            columns: ["wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
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
          archived: boolean
          atomicity_warning: string | null
          confidence: number
          content: string
          created_at: string
          embedding: string | null
          embedding_model: string | null
          embedding_v2: unknown
          encoding_strength: number | null
          entry_type: string
          folder: string
          id: string
          importance: number | null
          is_index: boolean
          last_retrieved_at: string | null
          linked_wiki_id: string | null
          maturity: string
          next_review_at: string | null
          pending_changes: Json
          retrieval_count: number
          review_count: number
          source_book_id: string | null
          storage_strength: number
          subject: string | null
          supersede_reason: string | null
          superseded_by: string | null
          surprise: number | null
          tags: string[]
          title: string
          tsv: unknown
          updated_at: string
          user_id: string
          valid_from: string | null
          valid_to: string | null
          vibrancy: number
          wiki_id: string | null
        }
        Insert: {
          archived?: boolean
          atomicity_warning?: string | null
          confidence?: number
          content?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          embedding_v2?: unknown
          encoding_strength?: number | null
          entry_type?: string
          folder?: string
          id?: string
          importance?: number | null
          is_index?: boolean
          last_retrieved_at?: string | null
          linked_wiki_id?: string | null
          maturity?: string
          next_review_at?: string | null
          pending_changes?: Json
          retrieval_count?: number
          review_count?: number
          source_book_id?: string | null
          storage_strength?: number
          subject?: string | null
          supersede_reason?: string | null
          superseded_by?: string | null
          surprise?: number | null
          tags?: string[]
          title: string
          tsv?: unknown
          updated_at?: string
          user_id: string
          valid_from?: string | null
          valid_to?: string | null
          vibrancy?: number
          wiki_id?: string | null
        }
        Update: {
          archived?: boolean
          atomicity_warning?: string | null
          confidence?: number
          content?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string | null
          embedding_v2?: unknown
          encoding_strength?: number | null
          entry_type?: string
          folder?: string
          id?: string
          importance?: number | null
          is_index?: boolean
          last_retrieved_at?: string | null
          linked_wiki_id?: string | null
          maturity?: string
          next_review_at?: string | null
          pending_changes?: Json
          retrieval_count?: number
          review_count?: number
          source_book_id?: string | null
          storage_strength?: number
          subject?: string | null
          supersede_reason?: string | null
          superseded_by?: string | null
          surprise?: number | null
          tags?: string[]
          title?: string
          tsv?: unknown
          updated_at?: string
          user_id?: string
          valid_from?: string | null
          valid_to?: string | null
          vibrancy?: number
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
            foreignKeyName: "knowledge_entries_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
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
      master_assets: {
        Row: {
          assembly_tag: string
          banned_traits: string[]
          created_at: string
          entry_id: string | null
          front_azimuth_deg: number
          hero_image_id: string | null
          id: string
          name: string
          negative_constraints: string[]
          palette: string[]
          ref_embeddings: Json | null
          splat_id: string | null
          style_lock: string
          tech_pack_text: string
          updated_at: string
          user_id: string
          view_image_ids: string[]
        }
        Insert: {
          assembly_tag?: string
          banned_traits?: string[]
          created_at?: string
          entry_id?: string | null
          front_azimuth_deg?: number
          hero_image_id?: string | null
          id?: string
          name: string
          negative_constraints?: string[]
          palette?: string[]
          ref_embeddings?: Json | null
          splat_id?: string | null
          style_lock?: string
          tech_pack_text?: string
          updated_at?: string
          user_id: string
          view_image_ids?: string[]
        }
        Update: {
          assembly_tag?: string
          banned_traits?: string[]
          created_at?: string
          entry_id?: string | null
          front_azimuth_deg?: number
          hero_image_id?: string | null
          id?: string
          name?: string
          negative_constraints?: string[]
          palette?: string[]
          ref_embeddings?: Json | null
          splat_id?: string | null
          style_lock?: string
          tech_pack_text?: string
          updated_at?: string
          user_id?: string
          view_image_ids?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "master_assets_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_assets_hero_image_id_fkey"
            columns: ["hero_image_id"]
            isOneToOne: false
            referencedRelation: "image_attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_assets_splat_id_fkey"
            columns: ["splat_id"]
            isOneToOne: false
            referencedRelation: "splat_generations"
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
      splat_generations: {
        Row: {
          caption: string
          coord_system: string
          cost: number | null
          created_at: string
          entry_id: string | null
          error: string | null
          file_bytes: number | null
          format: string
          id: string
          mime: string
          model: string
          poster_path: string | null
          prompt: string
          provider: string
          request_id: string
          response_url: string | null
          source_image_id: string | null
          splat_count: number | null
          status: string
          status_url: string | null
          storage_path: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          caption?: string
          coord_system?: string
          cost?: number | null
          created_at?: string
          entry_id?: string | null
          error?: string | null
          file_bytes?: number | null
          format?: string
          id?: string
          mime?: string
          model?: string
          poster_path?: string | null
          prompt?: string
          provider?: string
          request_id: string
          response_url?: string | null
          source_image_id?: string | null
          splat_count?: number | null
          status?: string
          status_url?: string | null
          storage_path?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          caption?: string
          coord_system?: string
          cost?: number | null
          created_at?: string
          entry_id?: string | null
          error?: string | null
          file_bytes?: number | null
          format?: string
          id?: string
          mime?: string
          model?: string
          poster_path?: string | null
          prompt?: string
          provider?: string
          request_id?: string
          response_url?: string | null
          source_image_id?: string | null
          splat_count?: number | null
          status?: string
          status_url?: string | null
          storage_path?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "splat_generations_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "splat_generations_source_image_id_fkey"
            columns: ["source_image_id"]
            isOneToOne: false
            referencedRelation: "image_attachments"
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
          grant_note: string | null
          granted_at: string | null
          granted_by_admin_id: string | null
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
          grant_note?: string | null
          granted_at?: string | null
          granted_by_admin_id?: string | null
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
          grant_note?: string | null
          granted_at?: string | null
          granted_by_admin_id?: string | null
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
      tool_approvals: {
        Row: {
          approved_at: string
          id: string
          sha256: string
          tool_id: string
          user_id: string
        }
        Insert: {
          approved_at?: string
          id?: string
          sha256: string
          tool_id: string
          user_id: string
        }
        Update: {
          approved_at?: string
          id?: string
          sha256?: string
          tool_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_approvals_tool_id_fkey"
            columns: ["tool_id"]
            isOneToOne: false
            referencedRelation: "agent_tools"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_runs: {
        Row: {
          capability_calls: Json
          created_at: string
          error: string | null
          id: string
          ms: number | null
          sha256: string | null
          status: string
          tool_id: string | null
          user_id: string
        }
        Insert: {
          capability_calls?: Json
          created_at?: string
          error?: string | null
          id?: string
          ms?: number | null
          sha256?: string | null
          status?: string
          tool_id?: string | null
          user_id: string
        }
        Update: {
          capability_calls?: Json
          created_at?: string
          error?: string | null
          id?: string
          ms?: number | null
          sha256?: string | null
          status?: string
          tool_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_runs_tool_id_fkey"
            columns: ["tool_id"]
            isOneToOne: false
            referencedRelation: "agent_tools"
            referencedColumns: ["id"]
          },
        ]
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
          access_all_neurons: boolean
          active_wiki_id: string | null
          active_wiki_ids: string[]
          auto_approve_tool_updates: boolean
          auto_extract_figures: boolean
          auto_read_replies: boolean
          auto_show_memory_images: boolean
          burplexity_api_token: string | null
          chat_tool_permissions: Json
          created_at: string
          custom_system_prompt: string | null
          deep_research_model: string | null
          fal_api_key: string | null
          gemini_api_key: string | null
          hands_free_tts_rate: number
          id: string
          image_extraction_model: string | null
          image_model_fallback: string | null
          image_model_primary: string | null
          image_quality: string | null
          image_safety_check: boolean
          image_size: string | null
          inworld_api_key: string
          inworld_enabled: boolean
          inworld_voice_id: string
          is_recording_mode: boolean
          lean_mode: string
          library_ingest_auto_file: boolean
          library_ingest_model: string | null
          max_reply_sentences: number | null
          nvidia_api_key: string | null
          nvidia_key_last4: string | null
          openrouter_api_key: string | null
          saved_image_models: Json
          saved_models: Json | null
          saved_video_models: Json | null
          selected_model: string | null
          smart_filing_enabled: boolean
          splat_auto_fallback: boolean | null
          splat_click_to_activate: boolean | null
          splat_confirm_threshold: number | null
          splat_default_quality: string | null
          splat_max_file_mb: number | null
          splat_model_primary: string | null
          splat_monthly_quota: number | null
          tavily_api_key: string | null
          trust_image_text: boolean
          tts_rate: number
          updated_at: string
          user_id: string
          video_confirm_threshold: number | null
          video_default_aspect: string | null
          video_default_duration: number | null
          video_default_resolution: string | null
          video_generate_audio: boolean | null
          video_identity_scale: number | null
          video_model_primary: string | null
          video_motion_model: string | null
          video_qc_enabled: boolean | null
          vision_model: string | null
          voice_model: string | null
          wiki_model: string | null
        }
        Insert: {
          access_all_neurons?: boolean
          active_wiki_id?: string | null
          active_wiki_ids?: string[]
          auto_approve_tool_updates?: boolean
          auto_extract_figures?: boolean
          auto_read_replies?: boolean
          auto_show_memory_images?: boolean
          burplexity_api_token?: string | null
          chat_tool_permissions?: Json
          created_at?: string
          custom_system_prompt?: string | null
          deep_research_model?: string | null
          fal_api_key?: string | null
          gemini_api_key?: string | null
          hands_free_tts_rate?: number
          id?: string
          image_extraction_model?: string | null
          image_model_fallback?: string | null
          image_model_primary?: string | null
          image_quality?: string | null
          image_safety_check?: boolean
          image_size?: string | null
          inworld_api_key?: string
          inworld_enabled?: boolean
          inworld_voice_id?: string
          is_recording_mode?: boolean
          lean_mode?: string
          library_ingest_auto_file?: boolean
          library_ingest_model?: string | null
          max_reply_sentences?: number | null
          nvidia_api_key?: string | null
          nvidia_key_last4?: string | null
          openrouter_api_key?: string | null
          saved_image_models?: Json
          saved_models?: Json | null
          saved_video_models?: Json | null
          selected_model?: string | null
          smart_filing_enabled?: boolean
          splat_auto_fallback?: boolean | null
          splat_click_to_activate?: boolean | null
          splat_confirm_threshold?: number | null
          splat_default_quality?: string | null
          splat_max_file_mb?: number | null
          splat_model_primary?: string | null
          splat_monthly_quota?: number | null
          tavily_api_key?: string | null
          trust_image_text?: boolean
          tts_rate?: number
          updated_at?: string
          user_id: string
          video_confirm_threshold?: number | null
          video_default_aspect?: string | null
          video_default_duration?: number | null
          video_default_resolution?: string | null
          video_generate_audio?: boolean | null
          video_identity_scale?: number | null
          video_model_primary?: string | null
          video_motion_model?: string | null
          video_qc_enabled?: boolean | null
          vision_model?: string | null
          voice_model?: string | null
          wiki_model?: string | null
        }
        Update: {
          access_all_neurons?: boolean
          active_wiki_id?: string | null
          active_wiki_ids?: string[]
          auto_approve_tool_updates?: boolean
          auto_extract_figures?: boolean
          auto_read_replies?: boolean
          auto_show_memory_images?: boolean
          burplexity_api_token?: string | null
          chat_tool_permissions?: Json
          created_at?: string
          custom_system_prompt?: string | null
          deep_research_model?: string | null
          fal_api_key?: string | null
          gemini_api_key?: string | null
          hands_free_tts_rate?: number
          id?: string
          image_extraction_model?: string | null
          image_model_fallback?: string | null
          image_model_primary?: string | null
          image_quality?: string | null
          image_safety_check?: boolean
          image_size?: string | null
          inworld_api_key?: string
          inworld_enabled?: boolean
          inworld_voice_id?: string
          is_recording_mode?: boolean
          lean_mode?: string
          library_ingest_auto_file?: boolean
          library_ingest_model?: string | null
          max_reply_sentences?: number | null
          nvidia_api_key?: string | null
          nvidia_key_last4?: string | null
          openrouter_api_key?: string | null
          saved_image_models?: Json
          saved_models?: Json | null
          saved_video_models?: Json | null
          selected_model?: string | null
          smart_filing_enabled?: boolean
          splat_auto_fallback?: boolean | null
          splat_click_to_activate?: boolean | null
          splat_confirm_threshold?: number | null
          splat_default_quality?: string | null
          splat_max_file_mb?: number | null
          splat_model_primary?: string | null
          splat_monthly_quota?: number | null
          tavily_api_key?: string | null
          trust_image_text?: boolean
          tts_rate?: number
          updated_at?: string
          user_id?: string
          video_confirm_threshold?: number | null
          video_default_aspect?: string | null
          video_default_duration?: number | null
          video_default_resolution?: string | null
          video_generate_audio?: boolean | null
          video_identity_scale?: number | null
          video_model_primary?: string | null
          video_motion_model?: string | null
          video_qc_enabled?: boolean | null
          vision_model?: string | null
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
      video_generations: {
        Row: {
          aspect_ratio: string | null
          assembly_instruction: string | null
          caption: string
          condition_mode: string | null
          cost: number | null
          created_at: string
          duration_s: number | null
          entry_id: string | null
          error: string | null
          has_audio: boolean | null
          id: string
          identity_scale: number | null
          job_id: string
          lock_palette: string[] | null
          master_id: string | null
          mime: string
          model: string
          motion_mode: string | null
          motion_video_id: string | null
          negative_constraints: string[] | null
          poster_path: string | null
          prompt: string
          provider: string
          qc: Json | null
          resolution: string | null
          source_image_ids: string[] | null
          source_splat_id: string | null
          status: string
          storage_path: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          aspect_ratio?: string | null
          assembly_instruction?: string | null
          caption?: string
          condition_mode?: string | null
          cost?: number | null
          created_at?: string
          duration_s?: number | null
          entry_id?: string | null
          error?: string | null
          has_audio?: boolean | null
          id?: string
          identity_scale?: number | null
          job_id: string
          lock_palette?: string[] | null
          master_id?: string | null
          mime?: string
          model?: string
          motion_mode?: string | null
          motion_video_id?: string | null
          negative_constraints?: string[] | null
          poster_path?: string | null
          prompt?: string
          provider?: string
          qc?: Json | null
          resolution?: string | null
          source_image_ids?: string[] | null
          source_splat_id?: string | null
          status?: string
          storage_path?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          aspect_ratio?: string | null
          assembly_instruction?: string | null
          caption?: string
          condition_mode?: string | null
          cost?: number | null
          created_at?: string
          duration_s?: number | null
          entry_id?: string | null
          error?: string | null
          has_audio?: boolean | null
          id?: string
          identity_scale?: number | null
          job_id?: string
          lock_palette?: string[] | null
          master_id?: string | null
          mime?: string
          model?: string
          motion_mode?: string | null
          motion_video_id?: string | null
          negative_constraints?: string[] | null
          poster_path?: string | null
          prompt?: string
          provider?: string
          qc?: Json | null
          resolution?: string | null
          source_image_ids?: string[] | null
          source_splat_id?: string | null
          status?: string
          storage_path?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_generations_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "knowledge_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_generations_master_id_fkey"
            columns: ["master_id"]
            isOneToOne: false
            referencedRelation: "master_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_generations_motion_video_id_fkey"
            columns: ["motion_video_id"]
            isOneToOne: false
            referencedRelation: "video_generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_generations_source_splat_id_fkey"
            columns: ["source_splat_id"]
            isOneToOne: false
            referencedRelation: "splat_generations"
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
      wiki_chain_members: {
        Row: {
          chain_id: string
          created_at: string
          position: number
          wiki_id: string
        }
        Insert: {
          chain_id: string
          created_at?: string
          position?: number
          wiki_id: string
        }
        Update: {
          chain_id?: string
          created_at?: string
          position?: number
          wiki_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wiki_chain_members_chain_id_fkey"
            columns: ["chain_id"]
            isOneToOne: false
            referencedRelation: "wiki_chains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wiki_chain_members_wiki_id_fkey"
            columns: ["wiki_id"]
            isOneToOne: false
            referencedRelation: "wikis"
            referencedColumns: ["id"]
          },
        ]
      }
      wiki_chains: {
        Row: {
          cover_color: string
          created_at: string
          description: string
          id: string
          last_used_at: string | null
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cover_color?: string
          created_at?: string
          description?: string
          id?: string
          last_used_at?: string | null
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cover_color?: string
          created_at?: string
          description?: string
          id?: string
          last_used_at?: string | null
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
      accessible_wiki_ids: { Args: { uid: string }; Returns: string[] }
      admin_delete_user: { Args: { _user_id: string }; Returns: undefined }
      admin_grant_lifetime: {
        Args: { _note?: string; _user_id: string }
        Returns: undefined
      }
      admin_list_all_wikis: {
        Args: never
        Returns: {
          cover_color: string
          created_at: string
          description: string
          entry_count: number
          id: string
          is_default: boolean
          is_meta: boolean
          last_loaded_at: string
          name: string
          owner_email: string
          tags: string[]
          updated_at: string
          user_id: string
        }[]
      }
      admin_list_users: {
        Args: never
        Returns: {
          burplexity_api_token: string
          created_at: string
          deep_research_model: string
          email: string
          granted_by_admin_id: string
          id: string
          inworld_api_key: string
          is_admin: boolean
          last_seen: string
          last_sign_in_at: string
          openrouter_api_key: string
          plan: string
          selected_model: string
          subscribed: boolean
          subscription_end: string
          visits_today: number
          visits_total: number
          voice_model: string
          wiki_model: string
        }[]
      }
      admin_list_wiki_entries: {
        Args: { _limit?: number; _wiki_id: string }
        Returns: {
          content: string
          created_at: string
          entry_type: string
          id: string
          tags: string[]
          title: string
        }[]
      }
      admin_revoke_lifetime: { Args: { _user_id: string }; Returns: undefined }
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
      approve_tool: {
        Args: { p_expected_sha256: string; p_tool_id: string }
        Returns: Json
      }
      claim_next_ingest_job: {
        Args: { _user_id: string }
        Returns: {
          attempts: number
          book_id: string | null
          created_at: string
          error: string | null
          finished_at: string | null
          folder_id: string | null
          id: string
          model: string | null
          progress: string | null
          result: Json | null
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
          wiki_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "ingest_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
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
      delete_entries_bulk: { Args: { entry_ids: string[] }; Returns: number }
      entries_due_for_review: {
        Args: { _limit?: number; _wiki_id?: string }
        Returns: {
          content: string
          entry_type: string
          id: string
          next_review_at: string
          storage_strength: number
          title: string
          vibrancy: number
          wiki_id: string
        }[]
      }
      entries_for_wiki: {
        Args: { target_wiki_id: string }
        Returns: {
          archived: boolean
          atomicity_warning: string | null
          confidence: number
          content: string
          created_at: string
          embedding: string | null
          embedding_model: string | null
          embedding_v2: unknown
          encoding_strength: number | null
          entry_type: string
          folder: string
          id: string
          importance: number | null
          is_index: boolean
          last_retrieved_at: string | null
          linked_wiki_id: string | null
          maturity: string
          next_review_at: string | null
          pending_changes: Json
          retrieval_count: number
          review_count: number
          source_book_id: string | null
          storage_strength: number
          subject: string | null
          supersede_reason: string | null
          superseded_by: string | null
          surprise: number | null
          tags: string[]
          title: string
          tsv: unknown
          updated_at: string
          user_id: string
          valid_from: string | null
          valid_to: string | null
          vibrancy: number
          wiki_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "knowledge_entries"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      entry_lineage: {
        Args: { _entry_id: string }
        Returns: {
          content: string
          depth: number
          entry_type: string
          id: string
          is_current: boolean
          supersede_reason: string
          superseded_by: string
          title: string
          valid_from: string
          valid_to: string
        }[]
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
      match_image_memories: {
        Args: {
          filter_wiki_id?: string
          match_count: number
          match_threshold: number
          query_embedding: unknown
        }
        Returns: {
          caption: string
          created_at: string
          id: string
          mime_type: string
          ocr_text: string
          similarity: number
          source: string
          storage_path: string
          tags: string[]
          wiki_id: string
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
      memory_edge_delete: {
        Args: { _source: string; _target: string }
        Returns: number
      }
      memory_edge_upsert: {
        Args: { _relationship: string; _source: string; _target: string }
        Returns: string
      }
      memory_entry_upsert: {
        Args: {
          _confidence: number
          _content: string
          _entry_type: string
          _id: string
          _tags: string[]
          _title: string
          _wiki_id: string
        }
        Returns: string
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
      my_entitlements: { Args: never; Returns: Json }
      record_review: {
        Args: { _entry_id: string; _recalled?: boolean }
        Returns: string
      }
      renormalize_vibrancy: {
        Args: { _target_mean?: number; _user_id: string; _wiki_id?: string }
        Returns: number
      }
      requeue_stuck_ingest_jobs: {
        Args: never
        Returns: {
          requeued: number
          user_id: string
        }[]
      }
      scan_cleanup_flags: {
        Args: { target_wiki_id?: string }
        Returns: {
          added: number
          reason: string
        }[]
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
      supersede_knowledge_entry: {
        Args: {
          _also_supersede?: string
          _new_content?: string
          _new_entry_type?: string
          _new_tags?: string[]
          _new_title?: string
          _old_id: string
          _reason?: string
        }
        Returns: string
      }
      tool_fingerprint: { Args: { p_tool_id: string }; Returns: string }
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
