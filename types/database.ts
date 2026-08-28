export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      ai_call_logs: {
        Row: {
          analysis_id: string | null
          cost_estimate: number | null
          created_at: string
          feature: Database["public"]["Enums"]["ai_feature"]
          findings_discarded: number | null
          findings_generated: number | null
          id: string
          latency_ms: number | null
          model: string | null
          prompt_version: string | null
          retry_count: number
          token_in: number | null
          token_out: number | null
          updated_at: string
          validation_result: string | null
        }
        Insert: {
          analysis_id?: string | null
          cost_estimate?: number | null
          created_at?: string
          feature: Database["public"]["Enums"]["ai_feature"]
          findings_discarded?: number | null
          findings_generated?: number | null
          id?: string
          latency_ms?: number | null
          model?: string | null
          prompt_version?: string | null
          retry_count?: number
          token_in?: number | null
          token_out?: number | null
          updated_at?: string
          validation_result?: string | null
        }
        Update: {
          analysis_id?: string | null
          cost_estimate?: number | null
          created_at?: string
          feature?: Database["public"]["Enums"]["ai_feature"]
          findings_discarded?: number | null
          findings_generated?: number | null
          id?: string
          latency_ms?: number | null
          model?: string | null
          prompt_version?: string | null
          retry_count?: number
          token_in?: number | null
          token_out?: number | null
          updated_at?: string
          validation_result?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_call_logs_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "document_analyses"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_conversations: {
        Row: {
          context_snapshot_json: Json
          couple_id: string
          created_at: string
          id: string
          last_message_at: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          context_snapshot_json?: Json
          couple_id: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          context_snapshot_json?: Json
          couple_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_conversations_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_messages: {
        Row: {
          content: string | null
          conversation_id: string
          created_at: string
          id: string
          role: string
          token_in: number | null
          token_out: number | null
          tool_calls_json: Json | null
          updated_at: string
        }
        Insert: {
          content?: string | null
          conversation_id: string
          created_at?: string
          id?: string
          role: string
          token_in?: number | null
          token_out?: number | null
          tool_calls_json?: Json | null
          updated_at?: string
        }
        Update: {
          content?: string | null
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
          token_in?: number | null
          token_out?: number | null
          tool_calls_json?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_report_reviews: {
        Row: {
          analysis_id: string
          created_at: string
          id: string
          note: string
          reviewer_id: string
          updated_at: string
          verdict: string
        }
        Insert: {
          analysis_id: string
          created_at?: string
          id?: string
          note: string
          reviewer_id: string
          updated_at?: string
          verdict: string
        }
        Update: {
          analysis_id?: string
          created_at?: string
          id?: string
          note?: string
          reviewer_id?: string
          updated_at?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_report_reviews_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "document_analyses"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_tool_calls: {
        Row: {
          arguments_json: Json | null
          created_at: string
          error: string | null
          id: string
          latency_ms: number | null
          message_id: string
          result_summary: string | null
          tool_name: string
          updated_at: string
        }
        Insert: {
          arguments_json?: Json | null
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          message_id: string
          result_summary?: string | null
          tool_name: string
          updated_at?: string
        }
        Update: {
          arguments_json?: Json | null
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          message_id?: string
          result_summary?: string | null
          tool_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_tool_calls_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "ai_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          created_at: string
          description: string | null
          id: string
          key: string
          updated_at: string
          updated_by: string | null
          value_json: Json
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          key: string
          updated_at?: string
          updated_by?: string | null
          value_json?: Json
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          updated_at?: string
          updated_by?: string | null
          value_json?: Json
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_role: Database["public"]["Enums"]["user_role"] | null
          after_json: Json | null
          before_json: Json | null
          created_at: string
          id: string
          ip_hash: string | null
          resolution_basis: string[] | null
          target_id: string | null
          target_type: string
          updated_at: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["user_role"] | null
          after_json?: Json | null
          before_json?: Json | null
          created_at?: string
          id?: string
          ip_hash?: string | null
          resolution_basis?: string[] | null
          target_id?: string | null
          target_type: string
          updated_at?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["user_role"] | null
          after_json?: Json | null
          before_json?: Json | null
          created_at?: string
          id?: string
          ip_hash?: string | null
          resolution_basis?: string[] | null
          target_id?: string | null
          target_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      bookings: {
        Row: {
          applied_fee_rate_bp: number | null
          applied_planner_fee_rate_bp: number | null
          couple_id: string
          created_at: string
          deposit_amount: number
          id: string
          product_id: string | null
          slot_id: string | null
          status: Database["public"]["Enums"]["booking_status"]
          total_amount: number
          updated_at: string
          vendor_id: string
        }
        Insert: {
          applied_fee_rate_bp?: number | null
          applied_planner_fee_rate_bp?: number | null
          couple_id: string
          created_at?: string
          deposit_amount?: number
          id?: string
          product_id?: string | null
          slot_id?: string | null
          status?: Database["public"]["Enums"]["booking_status"]
          total_amount: number
          updated_at?: string
          vendor_id: string
        }
        Update: {
          applied_fee_rate_bp?: number | null
          applied_planner_fee_rate_bp?: number | null
          couple_id?: string
          created_at?: string
          deposit_amount?: number
          id?: string
          product_id?: string | null
          slot_id?: string | null
          status?: Database["public"]["Enums"]["booking_status"]
          total_amount?: number
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "inventory_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      budget_items: {
        Row: {
          budget_id: string
          category: string
          contracted_amount: number
          created_at: string
          id: string
          planned_amount: number
          spent_amount: number
          updated_at: string
        }
        Insert: {
          budget_id: string
          category: string
          contracted_amount?: number
          created_at?: string
          id?: string
          planned_amount?: number
          spent_amount?: number
          updated_at?: string
        }
        Update: {
          budget_id?: string
          category?: string
          contracted_amount?: number
          created_at?: string
          id?: string
          planned_amount?: number
          spent_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "budget_items_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
        ]
      }
      budgets: {
        Row: {
          allocation_json: Json
          couple_id: string
          created_at: string
          id: string
          index_version: string | null
          total_amount: number
          updated_at: string
        }
        Insert: {
          allocation_json?: Json
          couple_id: string
          created_at?: string
          id?: string
          index_version?: string | null
          total_amount?: number
          updated_at?: string
        }
        Update: {
          allocation_json?: Json
          couple_id?: string
          created_at?: string
          id?: string
          index_version?: string | null
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "budgets_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      cart_items: {
        Row: {
          added_by: string
          cart_id: string
          created_at: string
          id: string
          options_json: Json
          planner_selected: boolean
          price_at_add: number
          product_id: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          added_by: string
          cart_id: string
          created_at?: string
          id?: string
          options_json?: Json
          planner_selected?: boolean
          price_at_add: number
          product_id: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          added_by?: string
          cart_id?: string
          created_at?: string
          id?: string
          options_json?: Json
          planner_selected?: boolean
          price_at_add?: number
          product_id?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cart_items_cart_id_fkey"
            columns: ["cart_id"]
            isOneToOne: false
            referencedRelation: "carts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      carts: {
        Row: {
          couple_id: string
          created_at: string
          id: string
          name: string | null
          seq: number
          status: string
          updated_at: string
        }
        Insert: {
          couple_id: string
          created_at?: string
          id?: string
          name?: string | null
          seq: number
          status?: string
          updated_at?: string
        }
        Update: {
          couple_id?: string
          created_at?: string
          id?: string
          name?: string | null
          seq?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "carts_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          attachments: Json
          body: string | null
          created_at: string
          id: string
          read_at: string | null
          retracted_at: string | null
          retracted_by: string | null
          room_id: string
          sender_id: string | null
          sender_type: Database["public"]["Enums"]["chat_sender_type"]
        }
        Insert: {
          attachments?: Json
          body?: string | null
          created_at?: string
          id?: string
          read_at?: string | null
          retracted_at?: string | null
          retracted_by?: string | null
          room_id: string
          sender_id?: string | null
          sender_type: Database["public"]["Enums"]["chat_sender_type"]
        }
        Update: {
          attachments?: Json
          body?: string | null
          created_at?: string
          id?: string
          read_at?: string | null
          retracted_at?: string | null
          retracted_by?: string | null
          room_id?: string
          sender_id?: string | null
          sender_type?: Database["public"]["Enums"]["chat_sender_type"]
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "chat_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_room_reads: {
        Row: {
          created_at: string
          id: string
          last_read_at: string
          last_read_message_id: string | null
          room_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_read_at?: string
          last_read_message_id?: string | null
          room_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_read_at?: string
          last_read_message_id?: string | null
          room_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_room_reads_last_read_message_id_fkey"
            columns: ["last_read_message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_room_reads_last_read_message_id_fkey"
            columns: ["last_read_message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages_visible"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_room_reads_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "chat_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_rooms: {
        Row: {
          assigned_to: string | null
          awaiting_vendor_since: string | null
          couple_id: string
          created_at: string
          id: string
          last_message_at: string | null
          status: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          assigned_to?: string | null
          awaiting_vendor_since?: string | null
          couple_id: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          status?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          assigned_to?: string | null
          awaiting_vendor_since?: string | null
          couple_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_rooms_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_rooms_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_rates: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          fee_rate_bp: number
          id: string
          memo: string | null
          scope_key: string | null
          scope_type: Database["public"]["Enums"]["commission_scope_type"]
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          fee_rate_bp: number
          id?: string
          memo?: string | null
          scope_key?: string | null
          scope_type: Database["public"]["Enums"]["commission_scope_type"]
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          fee_rate_bp?: number
          id?: string
          memo?: string | null
          scope_key?: string | null
          scope_type?: Database["public"]["Enums"]["commission_scope_type"]
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      community_comments: {
        Row: {
          author_id: string
          body: string
          created_at: string
          id: string
          parent_id: string | null
          post_id: string
          status: string
          updated_at: string
        }
        Insert: {
          author_id?: string
          body: string
          created_at?: string
          id?: string
          parent_id?: string | null
          post_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          parent_id?: string | null
          post_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "community_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "community_comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "community_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      community_likes: {
        Row: {
          created_at: string
          id: string
          post_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "community_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      community_post_tags: {
        Row: {
          created_at: string
          id: string
          post_id: string
          tagged_by: string
          updated_at: string
          vendor_id: string
          verified_purchase: boolean
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          tagged_by?: string
          updated_at?: string
          vendor_id: string
          verified_purchase?: boolean
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          tagged_by?: string
          updated_at?: string
          vendor_id?: string
          verified_purchase?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "community_post_tags_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "community_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "community_post_tags_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      community_posts: {
        Row: {
          author_id: string
          board_type: string
          body: string
          category: string | null
          created_at: string
          id: string
          is_pinned: boolean
          like_count: number
          status: string
          title: string
          updated_at: string
          view_count: number
        }
        Insert: {
          author_id?: string
          board_type: string
          body: string
          category?: string | null
          created_at?: string
          id?: string
          is_pinned?: boolean
          like_count?: number
          status?: string
          title: string
          updated_at?: string
          view_count?: number
        }
        Update: {
          author_id?: string
          board_type?: string
          body?: string
          category?: string | null
          created_at?: string
          id?: string
          is_pinned?: boolean
          like_count?: number
          status?: string
          title?: string
          updated_at?: string
          view_count?: number
        }
        Relationships: []
      }
      community_reports: {
        Row: {
          created_at: string
          id: string
          reason_code: string
          reporter_id: string
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          target_id: string
          target_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          reason_code: string
          reporter_id?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_id: string
          target_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          reason_code?: string
          reporter_id?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_id?: string
          target_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      community_scraps: {
        Row: {
          created_at: string
          id: string
          post_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_scraps_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "community_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      consents: {
        Row: {
          agreed_at: string
          consent_type: string
          created_at: string
          id: string
          ip_hash: string | null
          updated_at: string
          user_id: string
          version: string
        }
        Insert: {
          agreed_at?: string
          consent_type: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          updated_at?: string
          user_id: string
          version: string
        }
        Update: {
          agreed_at?: string
          consent_type?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          updated_at?: string
          user_id?: string
          version?: string
        }
        Relationships: []
      }
      consultation_deposits: {
        Row: {
          amount: number
          attempt_count: number
          consultation_id: string
          created_at: string
          currency: string
          failure_reason: string | null
          held_at: string | null
          id: string
          idempotency_key: string | null
          payment_id: string | null
          provider: string | null
          provider_ref: string | null
          refund_id: string | null
          resolution_reason: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          attempt_count?: number
          consultation_id: string
          created_at?: string
          currency?: string
          failure_reason?: string | null
          held_at?: string | null
          id?: string
          idempotency_key?: string | null
          payment_id?: string | null
          provider?: string | null
          provider_ref?: string | null
          refund_id?: string | null
          resolution_reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          attempt_count?: number
          consultation_id?: string
          created_at?: string
          currency?: string
          failure_reason?: string | null
          held_at?: string | null
          id?: string
          idempotency_key?: string | null
          payment_id?: string | null
          provider?: string | null
          provider_ref?: string | null
          refund_id?: string | null
          resolution_reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "consultation_deposits_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: true
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consultation_deposits_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consultation_deposits_refund_id_fkey"
            columns: ["refund_id"]
            isOneToOne: false
            referencedRelation: "refunds"
            referencedColumns: ["id"]
          },
        ]
      }
      consultations: {
        Row: {
          approved_at: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          confirm_due_at: string | null
          couple_confirmed_at: string | null
          couple_id: string
          couple_outcome:
            | Database["public"]["Enums"]["consultation_outcome"]
            | null
          created_at: string
          duration_minutes: number
          ends_at: string
          id: string
          location: string | null
          outcome: Database["public"]["Enums"]["consultation_outcome"] | null
          planner_id: string | null
          reject_reason: string | null
          rejected_at: string | null
          requested_at: string
          resolved_at: string | null
          scheduled_at: string
          status: Database["public"]["Enums"]["consultation_status"]
          type: Database["public"]["Enums"]["consultation_type"]
          updated_at: string
          vendor_confirmed_at: string | null
          vendor_id: string
          vendor_outcome:
            | Database["public"]["Enums"]["consultation_outcome"]
            | null
        }
        Insert: {
          approved_at?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          confirm_due_at?: string | null
          couple_confirmed_at?: string | null
          couple_id: string
          couple_outcome?:
            | Database["public"]["Enums"]["consultation_outcome"]
            | null
          created_at?: string
          duration_minutes: number
          ends_at: string
          id?: string
          location?: string | null
          outcome?: Database["public"]["Enums"]["consultation_outcome"] | null
          planner_id?: string | null
          reject_reason?: string | null
          rejected_at?: string | null
          requested_at?: string
          resolved_at?: string | null
          scheduled_at: string
          status?: Database["public"]["Enums"]["consultation_status"]
          type: Database["public"]["Enums"]["consultation_type"]
          updated_at?: string
          vendor_confirmed_at?: string | null
          vendor_id: string
          vendor_outcome?:
            | Database["public"]["Enums"]["consultation_outcome"]
            | null
        }
        Update: {
          approved_at?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          confirm_due_at?: string | null
          couple_confirmed_at?: string | null
          couple_id?: string
          couple_outcome?:
            | Database["public"]["Enums"]["consultation_outcome"]
            | null
          created_at?: string
          duration_minutes?: number
          ends_at?: string
          id?: string
          location?: string | null
          outcome?: Database["public"]["Enums"]["consultation_outcome"] | null
          planner_id?: string | null
          reject_reason?: string | null
          rejected_at?: string | null
          requested_at?: string
          resolved_at?: string | null
          scheduled_at?: string
          status?: Database["public"]["Enums"]["consultation_status"]
          type?: Database["public"]["Enums"]["consultation_type"]
          updated_at?: string
          vendor_confirmed_at?: string | null
          vendor_id?: string
          vendor_outcome?:
            | Database["public"]["Enums"]["consultation_outcome"]
            | null
        }
        Relationships: [
          {
            foreignKeyName: "consultations_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consultations_planner_id_fkey"
            columns: ["planner_id"]
            isOneToOne: false
            referencedRelation: "planners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consultations_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      content_posts: {
        Row: {
          author_id: string | null
          body_md: string | null
          created_at: string
          id: string
          published_at: string | null
          seo_json: Json
          slug: string
          title: string
          type: Database["public"]["Enums"]["content_post_type"]
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body_md?: string | null
          created_at?: string
          id?: string
          published_at?: string | null
          seo_json?: Json
          slug: string
          title: string
          type: Database["public"]["Enums"]["content_post_type"]
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body_md?: string | null
          created_at?: string
          id?: string
          published_at?: string | null
          seo_json?: Json
          slug?: string
          title?: string
          type?: Database["public"]["Enums"]["content_post_type"]
          updated_at?: string
        }
        Relationships: []
      }
      content_revisions: {
        Row: {
          body_md: string | null
          created_at: string
          editor_id: string | null
          id: string
          note: string
          post_id: string
          published_at: string | null
          revision: number
          seo_json: Json
          title: string
        }
        Insert: {
          body_md?: string | null
          created_at?: string
          editor_id?: string | null
          id?: string
          note: string
          post_id: string
          published_at?: string | null
          revision: number
          seo_json?: Json
          title: string
        }
        Update: {
          body_md?: string | null
          created_at?: string
          editor_id?: string | null
          id?: string
          note?: string
          post_id?: string
          published_at?: string | null
          revision?: number
          seo_json?: Json
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_revisions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "content_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_cancellations: {
        Row: {
          admin_decision: string | null
          balance_due: number | null
          band_code: string | null
          band_label: string | null
          basis_ref: string | null
          booking_id: string
          confirm_due_at: string | null
          contract_id: string
          couple_agreed: boolean | null
          couple_claim: string | null
          created_at: string
          disputed_at: string | null
          fault: string
          id: string
          is_draft_rules: boolean
          paid_amount: number | null
          penalty_applied: number | null
          penalty_contract: number | null
          penalty_standard: number | null
          reason_code: string
          reason_note: string | null
          refund_amount: number | null
          requested_by: string | null
          requester_side: string
          resolution_note: string | null
          resolved_by: string | null
          rule_version: string | null
          settled_at: string | null
          status: string
          updated_at: string
          vendor_agreed: boolean | null
          vendor_claim: string | null
        }
        Insert: {
          admin_decision?: string | null
          balance_due?: number | null
          band_code?: string | null
          band_label?: string | null
          basis_ref?: string | null
          booking_id: string
          confirm_due_at?: string | null
          contract_id: string
          couple_agreed?: boolean | null
          couple_claim?: string | null
          created_at?: string
          disputed_at?: string | null
          fault?: string
          id?: string
          is_draft_rules?: boolean
          paid_amount?: number | null
          penalty_applied?: number | null
          penalty_contract?: number | null
          penalty_standard?: number | null
          reason_code: string
          reason_note?: string | null
          refund_amount?: number | null
          requested_by?: string | null
          requester_side: string
          resolution_note?: string | null
          resolved_by?: string | null
          rule_version?: string | null
          settled_at?: string | null
          status?: string
          updated_at?: string
          vendor_agreed?: boolean | null
          vendor_claim?: string | null
        }
        Update: {
          admin_decision?: string | null
          balance_due?: number | null
          band_code?: string | null
          band_label?: string | null
          basis_ref?: string | null
          booking_id?: string
          confirm_due_at?: string | null
          contract_id?: string
          couple_agreed?: boolean | null
          couple_claim?: string | null
          created_at?: string
          disputed_at?: string | null
          fault?: string
          id?: string
          is_draft_rules?: boolean
          paid_amount?: number | null
          penalty_applied?: number | null
          penalty_contract?: number | null
          penalty_standard?: number | null
          reason_code?: string
          reason_note?: string | null
          refund_amount?: number | null
          requested_by?: string | null
          requester_side?: string
          resolution_note?: string | null
          resolved_by?: string | null
          rule_version?: string | null
          settled_at?: string | null
          status?: string
          updated_at?: string
          vendor_agreed?: boolean | null
          vendor_claim?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contract_cancellations_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_cancellations_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_signatures: {
        Row: {
          contract_id: string
          created_at: string
          id: string
          ip_hash: string | null
          signed_at: string | null
          signed_content_hash: string | null
          signer_id: string | null
          signer_role: string
          updated_at: string
          verification_method: string | null
          verification_ref: string | null
        }
        Insert: {
          contract_id: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          signed_at?: string | null
          signed_content_hash?: string | null
          signer_id?: string | null
          signer_role: string
          updated_at?: string
          verification_method?: string | null
          verification_ref?: string | null
        }
        Update: {
          contract_id?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          signed_at?: string | null
          signed_content_hash?: string | null
          signer_id?: string | null
          signer_role?: string
          updated_at?: string
          verification_method?: string | null
          verification_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contract_signatures_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_templates: {
        Row: {
          basis_note: string | null
          clause_body_status: string
          clauses_json: Json
          created_at: string
          effective_from: string | null
          effective_to: string | null
          id: string
          status: string
          updated_at: string
          version: string
        }
        Insert: {
          basis_note?: string | null
          clause_body_status?: string
          clauses_json?: Json
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          status?: string
          updated_at?: string
          version: string
        }
        Update: {
          basis_note?: string | null
          clause_body_status?: string
          clauses_json?: Json
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          status?: string
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      contracts: {
        Row: {
          activated_at: string | null
          applied_fee_rate_bp: number | null
          applied_planner_fee_rate_bp: number | null
          booking_id: string
          cancel_reason: string | null
          cancelled_at: string | null
          clauses_json: Json
          content_hash: string | null
          created_at: string
          id: string
          issued_at: string | null
          pdf_path: string | null
          planner_id: string | null
          quote_id: string | null
          signing_deadline_at: string | null
          status: string
          template_id: string | null
          template_version: string | null
          total_amount: number | null
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          applied_fee_rate_bp?: number | null
          applied_planner_fee_rate_bp?: number | null
          booking_id: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          clauses_json?: Json
          content_hash?: string | null
          created_at?: string
          id?: string
          issued_at?: string | null
          pdf_path?: string | null
          planner_id?: string | null
          quote_id?: string | null
          signing_deadline_at?: string | null
          status?: string
          template_id?: string | null
          template_version?: string | null
          total_amount?: number | null
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          applied_fee_rate_bp?: number | null
          applied_planner_fee_rate_bp?: number | null
          booking_id?: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          clauses_json?: Json
          content_hash?: string | null
          created_at?: string
          id?: string
          issued_at?: string | null
          pdf_path?: string | null
          planner_id?: string | null
          quote_id?: string | null
          signing_deadline_at?: string | null
          status?: string
          template_id?: string | null
          template_version?: string | null
          total_amount?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contracts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_planner_id_fkey"
            columns: ["planner_id"]
            isOneToOne: false
            referencedRelation: "planners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "contract_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          code: string
          couple_id: string
          created_at: string
          expires_at: string
          id: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          code: string
          couple_id: string
          created_at?: string
          expires_at: string
          id?: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          code?: string
          couple_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_invites_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_members: {
        Row: {
          couple_id: string
          created_at: string
          id: string
          joined_at: string
          member_role: Database["public"]["Enums"]["couple_member_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          couple_id: string
          created_at?: string
          id?: string
          joined_at?: string
          member_role: Database["public"]["Enums"]["couple_member_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          couple_id?: string
          created_at?: string
          id?: string
          joined_at?: string
          member_role?: Database["public"]["Enums"]["couple_member_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_members_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      couples: {
        Row: {
          created_at: string
          guest_count: number | null
          id: string
          owner_id: string
          region_code: string | null
          stage: string
          style_tags: string[]
          total_budget: number | null
          updated_at: string
          wedding_date: string | null
        }
        Insert: {
          created_at?: string
          guest_count?: number | null
          id?: string
          owner_id: string
          region_code?: string | null
          stage?: string
          style_tags?: string[]
          total_budget?: number | null
          updated_at?: string
          wedding_date?: string | null
        }
        Update: {
          created_at?: string
          guest_count?: number | null
          id?: string
          owner_id?: string
          region_code?: string | null
          stage?: string
          style_tags?: string[]
          total_budget?: number | null
          updated_at?: string
          wedding_date?: string | null
        }
        Relationships: []
      }
      coupon_issues: {
        Row: {
          couple_id: string | null
          coupon_id: string
          created_at: string
          expires_at: string | null
          id: string
          issued_at: string
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          couple_id?: string | null
          coupon_id: string
          created_at?: string
          expires_at?: string | null
          id?: string
          issued_at?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          couple_id?: string | null
          coupon_id?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          issued_at?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "coupon_issues_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_issues_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_redemptions: {
        Row: {
          booking_id: string | null
          borne_by: string
          coupon_issue_id: string
          created_at: string
          discount_amount: number
          id: string
          payment_id: string | null
          redeemed_at: string
        }
        Insert: {
          booking_id?: string | null
          borne_by: string
          coupon_issue_id: string
          created_at?: string
          discount_amount: number
          id?: string
          payment_id?: string | null
          redeemed_at?: string
        }
        Update: {
          booking_id?: string | null
          borne_by?: string
          coupon_issue_id?: string
          created_at?: string
          discount_amount?: number
          id?: string
          payment_id?: string | null
          redeemed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_redemptions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_coupon_issue_id_fkey"
            columns: ["coupon_issue_id"]
            isOneToOne: true
            referencedRelation: "coupon_issues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          created_at: string
          discount_type: string
          discount_value: number
          id: string
          issue_condition: string
          issued_count: number
          issuer_id: string | null
          issuer_type: string
          max_discount_amount: number | null
          min_order_amount: number
          name: string
          status: string
          total_quantity: number | null
          updated_at: string
          valid_from: string | null
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          discount_type: string
          discount_value: number
          id?: string
          issue_condition: string
          issued_count?: number
          issuer_id?: string | null
          issuer_type: string
          max_discount_amount?: number | null
          min_order_amount?: number
          name: string
          status?: string
          total_quantity?: number | null
          updated_at?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          discount_type?: string
          discount_value?: number
          id?: string
          issue_condition?: string
          issued_count?: number
          issuer_id?: string | null
          issuer_type?: string
          max_discount_amount?: number | null
          min_order_amount?: number
          name?: string
          status?: string
          total_quantity?: number | null
          updated_at?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "coupons_issuer_id_fkey"
            columns: ["issuer_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      data_deletion_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          requested_at: string
          resolution_reason: string | null
          resolved_by: string | null
          scope: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          requested_at?: string
          resolution_reason?: string | null
          resolved_by?: string | null
          scope: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          requested_at?: string
          resolution_reason?: string | null
          resolved_by?: string | null
          scope?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      detect_rules: {
        Row: {
          basis_ref: string | null
          category: string | null
          code: string
          created_at: string
          id: string
          is_active: boolean
          pattern_json: Json
          prompt_fragment: string | null
          severity_default: Database["public"]["Enums"]["finding_severity"]
          title: string
          updated_at: string
          version: string
        }
        Insert: {
          basis_ref?: string | null
          category?: string | null
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          pattern_json?: Json
          prompt_fragment?: string | null
          severity_default: Database["public"]["Enums"]["finding_severity"]
          title: string
          updated_at?: string
          version: string
        }
        Update: {
          basis_ref?: string | null
          category?: string | null
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          pattern_json?: Json
          prompt_fragment?: string | null
          severity_default?: Database["public"]["Enums"]["finding_severity"]
          title?: string
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      disputes: {
        Row: {
          booking_id: string
          couple_agreed: boolean
          created_at: string
          evidence_paths: string[]
          id: string
          proposal_note: string | null
          raised_by: string | null
          reason_code: string
          resolution_json: Json | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string
          vendor_agreed: boolean
        }
        Insert: {
          booking_id: string
          couple_agreed?: boolean
          created_at?: string
          evidence_paths?: string[]
          id?: string
          proposal_note?: string | null
          raised_by?: string | null
          reason_code: string
          resolution_json?: Json | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
          vendor_agreed?: boolean
        }
        Update: {
          booking_id?: string
          couple_agreed?: boolean
          created_at?: string
          evidence_paths?: string[]
          id?: string
          proposal_note?: string | null
          raised_by?: string | null
          reason_code?: string
          resolution_json?: Json | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
          vendor_agreed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "disputes_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
        ]
      }
      document_analyses: {
        Row: {
          created_at: string
          document_id: string
          id: string
          latency_ms: number | null
          model: string | null
          prompt_version: string | null
          risk_score: number | null
          rule_version: string | null
          status: string
          token_in: number | null
          token_out: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          document_id: string
          id?: string
          latency_ms?: number | null
          model?: string | null
          prompt_version?: string | null
          risk_score?: number | null
          rule_version?: string | null
          status?: string
          token_in?: number | null
          token_out?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          document_id?: string
          id?: string
          latency_ms?: number | null
          model?: string | null
          prompt_version?: string | null
          risk_score?: number | null
          rule_version?: string | null
          status?: string
          token_in?: number | null
          token_out?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_analyses_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          couple_id: string
          created_at: string
          doc_type: Database["public"]["Enums"]["document_type"]
          id: string
          mime: string | null
          page_count: number | null
          purge_scheduled_at: string
          purged_at: string | null
          storage_path: string
          updated_at: string
        }
        Insert: {
          couple_id: string
          created_at?: string
          doc_type: Database["public"]["Enums"]["document_type"]
          id?: string
          mime?: string | null
          page_count?: number | null
          purge_scheduled_at: string
          purged_at?: string | null
          storage_path: string
          updated_at?: string
        }
        Update: {
          couple_id?: string
          created_at?: string
          doc_type?: Database["public"]["Enums"]["document_type"]
          id?: string
          mime?: string | null
          page_count?: number | null
          purge_scheduled_at?: string
          purged_at?: string | null
          storage_path?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_events: {
        Row: {
          actor_id: string | null
          actor_role: string | null
          after_state: string | null
          before_state: string | null
          created_at: string
          entity_id: string
          entity_type: string
          event_type: string
          id: string
          ip_hash: string | null
          memo: string | null
          occurred_at: string
          source: Database["public"]["Enums"]["entity_event_source"]
        }
        Insert: {
          actor_id?: string | null
          actor_role?: string | null
          after_state?: string | null
          before_state?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          event_type: string
          id?: string
          ip_hash?: string | null
          memo?: string | null
          occurred_at?: string
          source?: Database["public"]["Enums"]["entity_event_source"]
        }
        Update: {
          actor_id?: string | null
          actor_role?: string | null
          after_state?: string | null
          before_state?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          event_type?: string
          id?: string
          ip_hash?: string | null
          memo?: string | null
          occurred_at?: string
          source?: Database["public"]["Enums"]["entity_event_source"]
        }
        Relationships: []
      }
      escrow_holds: {
        Row: {
          booking_id: string | null
          confirm_due_at: string | null
          couple_confirmed: boolean | null
          couple_confirmed_at: string | null
          created_at: string
          disputed_at: string | null
          held_amount: number
          held_at: string | null
          hold_reason: string | null
          id: string
          idempotency_key: string | null
          payment_id: string
          payment_schedule_id: string | null
          provider: string | null
          provider_ref: string | null
          refunded_at: string | null
          release_condition: Json
          release_reason: string | null
          released_at: string | null
          resolution_note: string | null
          resolved_by: string | null
          status: string
          updated_at: string
          vendor_confirmed: boolean | null
          vendor_confirmed_at: string | null
        }
        Insert: {
          booking_id?: string | null
          confirm_due_at?: string | null
          couple_confirmed?: boolean | null
          couple_confirmed_at?: string | null
          created_at?: string
          disputed_at?: string | null
          held_amount: number
          held_at?: string | null
          hold_reason?: string | null
          id?: string
          idempotency_key?: string | null
          payment_id: string
          payment_schedule_id?: string | null
          provider?: string | null
          provider_ref?: string | null
          refunded_at?: string | null
          release_condition?: Json
          release_reason?: string | null
          released_at?: string | null
          resolution_note?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
          vendor_confirmed?: boolean | null
          vendor_confirmed_at?: string | null
        }
        Update: {
          booking_id?: string | null
          confirm_due_at?: string | null
          couple_confirmed?: boolean | null
          couple_confirmed_at?: string | null
          created_at?: string
          disputed_at?: string | null
          held_amount?: number
          held_at?: string | null
          hold_reason?: string | null
          id?: string
          idempotency_key?: string | null
          payment_id?: string
          payment_schedule_id?: string | null
          provider?: string | null
          provider_ref?: string | null
          refunded_at?: string | null
          release_condition?: Json
          release_reason?: string | null
          released_at?: string | null
          resolution_note?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
          vendor_confirmed?: boolean | null
          vendor_confirmed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "escrow_holds_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escrow_holds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escrow_holds_payment_schedule_id_fkey"
            columns: ["payment_schedule_id"]
            isOneToOne: false
            referencedRelation: "payment_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      estimate_comparisons: {
        Row: {
          couple_id: string
          created_at: string
          id: string
          normalized_json: Json
          updated_at: string
          upload_ids: string[]
        }
        Insert: {
          couple_id: string
          created_at?: string
          id?: string
          normalized_json?: Json
          updated_at?: string
          upload_ids?: string[]
        }
        Update: {
          couple_id?: string
          created_at?: string
          id?: string
          normalized_json?: Json
          updated_at?: string
          upload_ids?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "estimate_comparisons_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      estimate_items: {
        Row: {
          amount: number
          confidence: number | null
          created_at: string
          estimate_upload_id: string
          id: string
          is_option: boolean
          mapped_category: string | null
          raw_label: string
          updated_at: string
        }
        Insert: {
          amount?: number
          confidence?: number | null
          created_at?: string
          estimate_upload_id: string
          id?: string
          is_option?: boolean
          mapped_category?: string | null
          raw_label: string
          updated_at?: string
        }
        Update: {
          amount?: number
          confidence?: number | null
          created_at?: string
          estimate_upload_id?: string
          id?: string
          is_option?: boolean
          mapped_category?: string | null
          raw_label?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "estimate_items_estimate_upload_id_fkey"
            columns: ["estimate_upload_id"]
            isOneToOne: false
            referencedRelation: "estimate_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      estimate_uploads: {
        Row: {
          created_at: string
          document_id: string
          id: string
          parsed_status: string
          updated_at: string
          vendor_name_masked: string | null
        }
        Insert: {
          created_at?: string
          document_id: string
          id?: string
          parsed_status?: string
          updated_at?: string
          vendor_name_masked?: string | null
        }
        Update: {
          created_at?: string
          document_id?: string
          id?: string
          parsed_status?: string
          updated_at?: string
          vendor_name_masked?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "estimate_uploads_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          budget_item_id: string | null
          category: string
          couple_id: string
          created_at: string
          id: string
          memo: string | null
          paid_at: string | null
          source_ref: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          budget_item_id?: string | null
          category: string
          couple_id: string
          created_at?: string
          id?: string
          memo?: string | null
          paid_at?: string | null
          source_ref?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          budget_item_id?: string | null
          category?: string
          couple_id?: string
          created_at?: string
          id?: string
          memo?: string | null
          paid_at?: string | null
          source_ref?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_budget_item_id_fkey"
            columns: ["budget_item_id"]
            isOneToOne: false
            referencedRelation: "budget_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          key: string
          rollout_json: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          key: string
          rollout_json?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          key?: string
          rollout_json?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      finding_reports: {
        Row: {
          analysis_id: string | null
          created_at: string
          finding_id: string | null
          id: string
          reason_code: string
          reporter_id: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          rule_code: string
          status: string
          updated_at: string
        }
        Insert: {
          analysis_id?: string | null
          created_at?: string
          finding_id?: string | null
          id?: string
          reason_code: string
          reporter_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          rule_code: string
          status?: string
          updated_at?: string
        }
        Update: {
          analysis_id?: string | null
          created_at?: string
          finding_id?: string | null
          id?: string
          reason_code?: string
          reporter_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          rule_code?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_reports_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "document_analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finding_reports_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "findings"
            referencedColumns: ["id"]
          },
        ]
      }
      findings: {
        Row: {
          analysis_id: string
          basis_ref: string | null
          citation_verified: boolean
          clause_excerpt_masked: string | null
          created_at: string
          explanation: string | null
          id: string
          negotiation_script: string | null
          rule_code: string
          severity: Database["public"]["Enums"]["finding_severity"]
          updated_at: string
        }
        Insert: {
          analysis_id: string
          basis_ref?: string | null
          citation_verified?: boolean
          clause_excerpt_masked?: string | null
          created_at?: string
          explanation?: string | null
          id?: string
          negotiation_script?: string | null
          rule_code: string
          severity: Database["public"]["Enums"]["finding_severity"]
          updated_at?: string
        }
        Update: {
          analysis_id?: string
          basis_ref?: string | null
          citation_verified?: boolean
          clause_excerpt_masked?: string | null
          created_at?: string
          explanation?: string | null
          id?: string
          negotiation_script?: string | null
          rule_code?: string
          severity?: Database["public"]["Enums"]["finding_severity"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "findings_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "document_analyses"
            referencedColumns: ["id"]
          },
        ]
      }
      guests: {
        Row: {
          contact_hash: string | null
          couple_id: string
          created_at: string
          id: string
          invite_token: string | null
          name: string
          party_size: number
          responded_at: string | null
          rsvp_status: string
          side: string
          updated_at: string
        }
        Insert: {
          contact_hash?: string | null
          couple_id: string
          created_at?: string
          id?: string
          invite_token?: string | null
          name: string
          party_size?: number
          responded_at?: string | null
          rsvp_status?: string
          side?: string
          updated_at?: string
        }
        Update: {
          contact_hash?: string | null
          couple_id?: string
          created_at?: string
          id?: string
          invite_token?: string | null
          name?: string
          party_size?: number
          responded_at?: string | null
          rsvp_status?: string
          side?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guests_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      inquiries: {
        Row: {
          budget_total: number | null
          categories: string[]
          closed_at: string | null
          couple_id: string
          created_at: string
          event_date: string | null
          guest_count: number | null
          id: string
          note: string | null
          region_code: string | null
          request_json: Json
          status: string
          updated_at: string
        }
        Insert: {
          budget_total?: number | null
          categories?: string[]
          closed_at?: string | null
          couple_id: string
          created_at?: string
          event_date?: string | null
          guest_count?: number | null
          id?: string
          note?: string | null
          region_code?: string | null
          request_json?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          budget_total?: number | null
          categories?: string[]
          closed_at?: string | null
          couple_id?: string
          created_at?: string
          event_date?: string | null
          guest_count?: number | null
          id?: string
          note?: string | null
          region_code?: string | null
          request_json?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inquiries_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      inquiry_targets: {
        Row: {
          created_at: string
          decline_reason_code: string | null
          declined_at: string | null
          first_viewed_at: string | null
          id: string
          inquiry_id: string
          responded_at: string | null
          sla_deadline: string | null
          status: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          created_at?: string
          decline_reason_code?: string | null
          declined_at?: string | null
          first_viewed_at?: string | null
          id?: string
          inquiry_id: string
          responded_at?: string | null
          sla_deadline?: string | null
          status?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          created_at?: string
          decline_reason_code?: string | null
          declined_at?: string | null
          first_viewed_at?: string | null
          id?: string
          inquiry_id?: string
          responded_at?: string | null
          sla_deadline?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inquiry_targets_inquiry_id_fkey"
            columns: ["inquiry_id"]
            isOneToOne: false
            referencedRelation: "inquiries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inquiry_targets_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_slots: {
        Row: {
          capacity: number
          created_at: string
          id: string
          product_id: string | null
          remaining: number
          slot_date: string
          slot_time: string | null
          status: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          capacity?: number
          created_at?: string
          id?: string
          product_id?: string | null
          remaining?: number
          slot_date: string
          slot_time?: string | null
          status?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          capacity?: number
          created_at?: string
          id?: string
          product_id?: string | null
          remaining?: number
          slot_date?: string
          slot_time?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_slots_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_slots_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      job_runs: {
        Row: {
          created_at: string
          error_summary: string | null
          finished_at: string | null
          id: string
          job_name: string
          processed_count: number
          started_at: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_summary?: string | null
          finished_at?: string | null
          id?: string
          job_name: string
          processed_count?: number
          started_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_summary?: string | null
          finished_at?: string | null
          id?: string
          job_name?: string
          processed_count?: number
          started_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      memberships: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          plan: Database["public"]["Enums"]["membership_plan"]
          source: string | null
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          plan?: Database["public"]["Enums"]["membership_plan"]
          source?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          plan?: Database["public"]["Enums"]["membership_plan"]
          source?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notification_prefs: {
        Row: {
          channel_flags: Json
          created_at: string
          id: string
          topic: string
          updated_at: string
          user_id: string
        }
        Insert: {
          channel_flags?: Json
          created_at?: string
          id?: string
          topic: string
          updated_at?: string
          user_id: string
        }
        Update: {
          channel_flags?: Json
          created_at?: string
          id?: string
          topic?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          attempt_count: number
          body_hash: string | null
          channel: string
          created_at: string
          dedupe_key: string | null
          delivered_at: string | null
          failed_at: string | null
          failure_reason: string | null
          id: string
          payload_json: Json
          provider_message_id: string | null
          read_at: string | null
          sent_at: string | null
          template_key: string | null
          topic: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          body_hash?: string | null
          channel: string
          created_at?: string
          dedupe_key?: string | null
          delivered_at?: string | null
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          payload_json?: Json
          provider_message_id?: string | null
          read_at?: string | null
          sent_at?: string | null
          template_key?: string | null
          topic: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          body_hash?: string | null
          channel?: string
          created_at?: string
          dedupe_key?: string | null
          delivered_at?: string | null
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          payload_json?: Json
          provider_message_id?: string | null
          read_at?: string | null
          sent_at?: string | null
          template_key?: string | null
          topic?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      onboarding_answers: {
        Row: {
          answer_json: Json
          couple_id: string
          created_at: string
          id: string
          question_key: string
          updated_at: string
        }
        Insert: {
          answer_json?: Json
          couple_id: string
          created_at?: string
          id?: string
          question_key: string
          updated_at?: string
        }
        Update: {
          answer_json?: Json
          couple_id?: string
          created_at?: string
          id?: string
          question_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_answers_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_consents: {
        Row: {
          agreed_at: string
          consent_version: string
          created_at: string
          id: string
          ip_hash: string | null
          kind: string
          payment_schedule_id: string
          user_id: string
        }
        Insert: {
          agreed_at?: string
          consent_version: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          kind: string
          payment_schedule_id: string
          user_id: string
        }
        Update: {
          agreed_at?: string
          consent_version?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          kind?: string
          payment_schedule_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_consents_payment_schedule_id_fkey"
            columns: ["payment_schedule_id"]
            isOneToOne: false
            referencedRelation: "payment_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_schedules: {
        Row: {
          amount: number
          contract_id: string
          created_at: string
          due_anchor: string
          due_at: string | null
          due_offset_days: number | null
          id: string
          paid_at: string | null
          ratio_bp: number
          seq: number
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          contract_id: string
          created_at?: string
          due_anchor: string
          due_at?: string | null
          due_offset_days?: number | null
          id?: string
          paid_at?: string | null
          ratio_bp: number
          seq: number
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          contract_id?: string
          created_at?: string
          due_anchor?: string
          due_at?: string | null
          due_offset_days?: number | null
          id?: string
          paid_at?: string | null
          ratio_bp?: number
          seq?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_schedules_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_webhook_events: {
        Row: {
          attempt_count: number
          created_at: string
          event_id: string
          event_type: string | null
          id: string
          last_error: string | null
          payload_digest: string
          payment_id: string | null
          payment_key: string | null
          processed_at: string | null
          provider: string
          received_at: string
          signature_ok: boolean | null
          status: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          event_id: string
          event_type?: string | null
          id?: string
          last_error?: string | null
          payload_digest: string
          payment_id?: string | null
          payment_key?: string | null
          processed_at?: string | null
          provider: string
          received_at?: string
          signature_ok?: boolean | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          event_id?: string
          event_type?: string | null
          id?: string
          last_error?: string | null
          payload_digest?: string
          payment_id?: string | null
          payment_key?: string | null
          processed_at?: string | null
          provider?: string
          received_at?: string
          signature_ok?: boolean | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_webhook_events_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          attempt_count: number
          booking_id: string | null
          cancelled_at: string | null
          created_at: string
          failed_at: string | null
          failure_reason: string | null
          id: string
          idempotency_key: string | null
          membership_id: string | null
          paid_at: string | null
          payment_schedule_id: string | null
          provider: string | null
          purpose: Database["public"]["Enums"]["payment_purpose"]
          raw_webhook_json: Json | null
          refunded_amount: number
          status: string
          toss_payment_key: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          attempt_count?: number
          booking_id?: string | null
          cancelled_at?: string | null
          created_at?: string
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          idempotency_key?: string | null
          membership_id?: string | null
          paid_at?: string | null
          payment_schedule_id?: string | null
          provider?: string | null
          purpose: Database["public"]["Enums"]["payment_purpose"]
          raw_webhook_json?: Json | null
          refunded_amount?: number
          status?: string
          toss_payment_key?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          attempt_count?: number
          booking_id?: string | null
          cancelled_at?: string | null
          created_at?: string
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          idempotency_key?: string | null
          membership_id?: string | null
          paid_at?: string | null
          payment_schedule_id?: string | null
          provider?: string | null
          purpose?: Database["public"]["Enums"]["payment_purpose"]
          raw_webhook_json?: Json | null
          refunded_amount?: number
          status?: string
          toss_payment_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_payment_schedule_id_fkey"
            columns: ["payment_schedule_id"]
            isOneToOne: false
            referencedRelation: "payment_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      penalty_rules: {
        Row: {
          band_code: string | null
          band_label: string | null
          basis_ref: string | null
          cancel_window: string
          category: string
          created_at: string
          id: string
          is_draft: boolean
          max_days_before_event: number | null
          min_days_before_event: number | null
          rate_bp: number | null
          refund_deposit: boolean
          updated_at: string
          version: string
        }
        Insert: {
          band_code?: string | null
          band_label?: string | null
          basis_ref?: string | null
          cancel_window: string
          category: string
          created_at?: string
          id?: string
          is_draft?: boolean
          max_days_before_event?: number | null
          min_days_before_event?: number | null
          rate_bp?: number | null
          refund_deposit?: boolean
          updated_at?: string
          version: string
        }
        Update: {
          band_code?: string | null
          band_label?: string | null
          basis_ref?: string | null
          cancel_window?: string
          category?: string
          created_at?: string
          id?: string
          is_draft?: boolean
          max_days_before_event?: number | null
          min_days_before_event?: number | null
          rate_bp?: number | null
          refund_deposit?: boolean
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      penalty_simulations: {
        Row: {
          contract_amount: number
          couple_id: string
          created_at: string
          excess_amount: number
          id: string
          inputs_json: Json
          rule_version: string | null
          standard_amount: number
          updated_at: string
        }
        Insert: {
          contract_amount?: number
          couple_id: string
          created_at?: string
          excess_amount?: number
          id?: string
          inputs_json?: Json
          rule_version?: string | null
          standard_amount?: number
          updated_at?: string
        }
        Update: {
          contract_amount?: number
          couple_id?: string
          created_at?: string
          excess_amount?: number
          id?: string
          inputs_json?: Json
          rule_version?: string | null
          standard_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "penalty_simulations_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      planner_engagements: {
        Row: {
          couple_id: string
          created_at: string
          id: string
          planner_id: string
          scope_json: Json
          status: string
          updated_at: string
          valid_from: string | null
          valid_to: string | null
        }
        Insert: {
          couple_id: string
          created_at?: string
          id?: string
          planner_id: string
          scope_json?: Json
          status?: string
          updated_at?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Update: {
          couple_id?: string
          created_at?: string
          id?: string
          planner_id?: string
          scope_json?: Json
          status?: string
          updated_at?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "planner_engagements_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planner_engagements_planner_id_fkey"
            columns: ["planner_id"]
            isOneToOne: false
            referencedRelation: "planners"
            referencedColumns: ["id"]
          },
        ]
      }
      planner_fee_rates: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          fee_rate_bp: number
          id: string
          memo: string | null
          scope_key: string | null
          scope_type: Database["public"]["Enums"]["planner_rate_scope_type"]
          service_level: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          fee_rate_bp: number
          id?: string
          memo?: string | null
          scope_key?: string | null
          scope_type: Database["public"]["Enums"]["planner_rate_scope_type"]
          service_level?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          fee_rate_bp?: number
          id?: string
          memo?: string | null
          scope_key?: string | null
          scope_type?: Database["public"]["Enums"]["planner_rate_scope_type"]
          service_level?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      planner_scopes: {
        Row: {
          category: string
          couple_id: string
          created_at: string
          id: string
          planner_id: string
          released_at: string | null
          selected_at: string
          selected_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          category: string
          couple_id: string
          created_at?: string
          id?: string
          planner_id: string
          released_at?: string | null
          selected_at?: string
          selected_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          category?: string
          couple_id?: string
          created_at?: string
          id?: string
          planner_id?: string
          released_at?: string | null
          selected_at?: string
          selected_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "planner_scopes_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planner_scopes_planner_id_fkey"
            columns: ["planner_id"]
            isOneToOne: false
            referencedRelation: "planners"
            referencedColumns: ["id"]
          },
        ]
      }
      planner_settlements: {
        Row: {
          booking_id: string
          created_at: string
          earned_at: string
          fee_amount: number
          fee_rate_bp: number
          gross_amount: number
          id: string
          paid_at: string | null
          payable_at: string
          planner_id: string
          status: string
          updated_at: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          earned_at: string
          fee_amount: number
          fee_rate_bp: number
          gross_amount: number
          id?: string
          paid_at?: string | null
          payable_at: string
          planner_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          earned_at?: string
          fee_amount?: number
          fee_rate_bp?: number
          gross_amount?: number
          id?: string
          paid_at?: string | null
          payable_at?: string
          planner_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "planner_settlements_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planner_settlements_planner_id_fkey"
            columns: ["planner_id"]
            isOneToOne: false
            referencedRelation: "planners"
            referencedColumns: ["id"]
          },
        ]
      }
      planners: {
        Row: {
          created_at: string
          fee_json: Json
          id: string
          profile_json: Json
          rating_avg: number | null
          regions: string[]
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          fee_json?: Json
          id?: string
          profile_json?: Json
          rating_avg?: number | null
          regions?: string[]
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          fee_json?: Json
          id?: string
          profile_json?: Json
          rating_avg?: number | null
          regions?: string[]
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      price_index: {
        Row: {
          category: string
          collected_at: string | null
          created_at: string
          guest_bucket: string
          id: string
          p25: number | null
          p50: number | null
          p75: number | null
          region_code: string
          sample_size: number
          season: string
          source_type: string | null
          updated_at: string
          version: string
        }
        Insert: {
          category: string
          collected_at?: string | null
          created_at?: string
          guest_bucket: string
          id?: string
          p25?: number | null
          p50?: number | null
          p75?: number | null
          region_code: string
          sample_size?: number
          season: string
          source_type?: string | null
          updated_at?: string
          version: string
        }
        Update: {
          category?: string
          collected_at?: string | null
          created_at?: string
          guest_bucket?: string
          id?: string
          p25?: number | null
          p50?: number | null
          p75?: number | null
          region_code?: string
          sample_size?: number
          season?: string
          source_type?: string | null
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      price_rules: {
        Row: {
          adjust_type: string
          adjust_value: number
          cap_price: number | null
          condition_json: Json
          created_at: string
          floor_price: number | null
          id: string
          is_active: boolean
          priority: number
          product_id: string | null
          rule_type: Database["public"]["Enums"]["price_rule_type"]
          updated_at: string
          vendor_id: string
        }
        Insert: {
          adjust_type: string
          adjust_value: number
          cap_price?: number | null
          condition_json?: Json
          created_at?: string
          floor_price?: number | null
          id?: string
          is_active?: boolean
          priority?: number
          product_id?: string | null
          rule_type: Database["public"]["Enums"]["price_rule_type"]
          updated_at?: string
          vendor_id: string
        }
        Update: {
          adjust_type?: string
          adjust_value?: number
          cap_price?: number | null
          condition_json?: Json
          created_at?: string
          floor_price?: number | null
          id?: string
          is_active?: boolean
          priority?: number
          product_id?: string | null
          rule_type?: Database["public"]["Enums"]["price_rule_type"]
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_rules_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_rules_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      price_sources: {
        Row: {
          created_at: string
          excluded_reason: string | null
          id: string
          index_id: string
          raw_value: number | null
          source_name: string
          source_url: string | null
          updated_at: string
          verified_by: string | null
        }
        Insert: {
          created_at?: string
          excluded_reason?: string | null
          id?: string
          index_id: string
          raw_value?: number | null
          source_name: string
          source_url?: string | null
          updated_at?: string
          verified_by?: string | null
        }
        Update: {
          created_at?: string
          excluded_reason?: string | null
          id?: string
          index_id?: string
          raw_value?: number | null
          source_name?: string
          source_url?: string | null
          updated_at?: string
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "price_sources_index_id_fkey"
            columns: ["index_id"]
            isOneToOne: false
            referencedRelation: "price_index"
            referencedColumns: ["id"]
          },
        ]
      }
      product_options: {
        Row: {
          created_at: string
          id: string
          is_mandatory: boolean
          name: string
          price: number
          product_id: string
          trigger_condition: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_mandatory?: boolean
          name: string
          price: number
          product_id: string
          trigger_condition?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_mandatory?: boolean
          name?: string
          price?: number
          product_id?: string
          trigger_condition?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_options_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          add_ons_declared_at: string | null
          base_price_total: number
          capacity_max: number | null
          capacity_min: number | null
          category: string
          created_at: string
          id: string
          included_items_json: Json
          name: string
          price_includes_vat: boolean
          published_at: string | null
          status: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          add_ons_declared_at?: string | null
          base_price_total: number
          capacity_max?: number | null
          capacity_min?: number | null
          category: string
          created_at?: string
          id?: string
          included_items_json?: Json
          name: string
          price_includes_vat?: boolean
          published_at?: string | null
          status?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          add_ons_declared_at?: string | null
          base_price_total?: number
          capacity_max?: number | null
          capacity_min?: number | null
          category?: string
          created_at?: string
          id?: string
          included_items_json?: Json
          name?: string
          price_includes_vat?: boolean
          published_at?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          marketing_opt_in: boolean
          phone_hash: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          marketing_opt_in?: boolean
          phone_hash?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          marketing_opt_in?: boolean
          phone_hash?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      prompt_versions: {
        Row: {
          created_at: string
          deployed_at: string | null
          deployed_by: string | null
          feature: Database["public"]["Enums"]["ai_feature"]
          id: string
          rollback_of: string | null
          schema_hash: string | null
          system_prompt: string
          updated_at: string
          version: string
        }
        Insert: {
          created_at?: string
          deployed_at?: string | null
          deployed_by?: string | null
          feature: Database["public"]["Enums"]["ai_feature"]
          id?: string
          rollback_of?: string | null
          schema_hash?: string | null
          system_prompt: string
          updated_at?: string
          version: string
        }
        Update: {
          created_at?: string
          deployed_at?: string | null
          deployed_by?: string | null
          feature?: Database["public"]["Enums"]["ai_feature"]
          id?: string
          rollback_of?: string | null
          schema_hash?: string | null
          system_prompt?: string
          updated_at?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "prompt_versions_rollback_of_fkey"
            columns: ["rollback_of"]
            isOneToOne: false
            referencedRelation: "prompt_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      qna_answers: {
        Row: {
          body: string
          created_at: string
          id: string
          post_id: string
          responder_id: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          post_id: string
          responder_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          post_id?: string
          responder_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "qna_answers_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "qna_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      qna_posts: {
        Row: {
          answered_at: string | null
          author_id: string
          body: string
          created_at: string
          id: string
          is_public: boolean
          status: string
          title: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          answered_at?: string | null
          author_id: string
          body: string
          created_at?: string
          id?: string
          is_public?: boolean
          status?: string
          title: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          answered_at?: string | null
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          is_public?: boolean
          status?: string
          title?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "qna_posts_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_items: {
        Row: {
          amount: number
          cap_amount: number
          category_code: string
          created_at: string
          discount_amount: number | null
          id: string
          is_mandatory: boolean
          is_option: boolean
          item_type: string
          label: string
          product_id: string | null
          product_option_id: string | null
          quote_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          cap_amount: number
          category_code: string
          created_at?: string
          discount_amount?: number | null
          id?: string
          is_mandatory?: boolean
          is_option?: boolean
          item_type?: string
          label: string
          product_id?: string | null
          product_option_id?: string | null
          quote_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          cap_amount?: number
          category_code?: string
          created_at?: string
          discount_amount?: number | null
          id?: string
          is_mandatory?: boolean
          is_option?: boolean
          item_type?: string
          label?: string
          product_id?: string | null
          product_option_id?: string | null
          quote_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_items_product_option_id_fkey"
            columns: ["product_option_id"]
            isOneToOne: false
            referencedRelation: "product_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_items_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          base_price_snapshot: number
          cap_total: number
          created_at: string
          decided_at: string | null
          discount_total: number | null
          id: string
          inquiry_target_id: string
          pricing_context_json: Json
          pricing_steps_json: Json
          product_id: string
          sent_at: string | null
          status: string
          total_amount: number
          updated_at: string
          valid_until: string | null
          vendor_memo: string | null
        }
        Insert: {
          base_price_snapshot: number
          cap_total: number
          created_at?: string
          decided_at?: string | null
          discount_total?: number | null
          id?: string
          inquiry_target_id: string
          pricing_context_json?: Json
          pricing_steps_json?: Json
          product_id: string
          sent_at?: string | null
          status?: string
          total_amount: number
          updated_at?: string
          valid_until?: string | null
          vendor_memo?: string | null
        }
        Update: {
          base_price_snapshot?: number
          cap_total?: number
          created_at?: string
          decided_at?: string | null
          discount_total?: number | null
          id?: string
          inquiry_target_id?: string
          pricing_context_json?: Json
          pricing_steps_json?: Json
          product_id?: string
          sent_at?: string | null
          status?: string
          total_amount?: number
          updated_at?: string
          valid_until?: string | null
          vendor_memo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_inquiry_target_id_fkey"
            columns: ["inquiry_target_id"]
            isOneToOne: false
            referencedRelation: "inquiry_targets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      refunds: {
        Row: {
          amount: number
          cancellation_id: string | null
          completed_at: string | null
          created_at: string
          id: string
          payment_id: string
          penalty_applied: number
          reason_code: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          cancellation_id?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          payment_id: string
          penalty_applied?: number
          reason_code?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          cancellation_id?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          payment_id?: string
          penalty_applied?: number
          reason_code?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_cancellation_id_fkey"
            columns: ["cancellation_id"]
            isOneToOne: false
            referencedRelation: "contract_cancellations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      review_reports: {
        Row: {
          created_at: string
          id: string
          reason_code: string
          reporter_id: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          review_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          reason_code: string
          reporter_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          review_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          reason_code?: string
          reporter_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          review_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_reports_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          body: string | null
          booking_id: string
          couple_id: string
          created_at: string
          disclosed_amount: number | null
          hidden_at: string | null
          hidden_by: string | null
          hidden_reason: string | null
          id: string
          retracted_at: string | null
          retracted_by: string | null
          score_fulfillment: number | null
          score_price: number | null
          score_response: number | null
          status: string
          updated_at: string
          vendor_id: string
          vendor_replied_at: string | null
          vendor_replied_by: string | null
          vendor_reply: string | null
        }
        Insert: {
          body?: string | null
          booking_id: string
          couple_id: string
          created_at?: string
          disclosed_amount?: number | null
          hidden_at?: string | null
          hidden_by?: string | null
          hidden_reason?: string | null
          id?: string
          retracted_at?: string | null
          retracted_by?: string | null
          score_fulfillment?: number | null
          score_price?: number | null
          score_response?: number | null
          status?: string
          updated_at?: string
          vendor_id: string
          vendor_replied_at?: string | null
          vendor_replied_by?: string | null
          vendor_reply?: string | null
        }
        Update: {
          body?: string | null
          booking_id?: string
          couple_id?: string
          created_at?: string
          disclosed_amount?: number | null
          hidden_at?: string | null
          hidden_by?: string | null
          hidden_reason?: string | null
          id?: string
          retracted_at?: string | null
          retracted_by?: string | null
          score_fulfillment?: number | null
          score_price?: number | null
          score_response?: number | null
          status?: string
          updated_at?: string
          vendor_id?: string
          vendor_replied_at?: string | null
          vendor_replied_by?: string | null
          vendor_reply?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      seating_plans: {
        Row: {
          couple_id: string
          created_at: string
          id: string
          layout_json: Json
          updated_at: string
          version: number
        }
        Insert: {
          couple_id: string
          created_at?: string
          id?: string
          layout_json?: Json
          updated_at?: string
          version?: number
        }
        Update: {
          couple_id?: string
          created_at?: string
          id?: string
          layout_json?: Json
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "seating_plans_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      settlement_adjustments: {
        Row: {
          amount: number
          applied_at: string | null
          applied_settlement_id: string | null
          booking_id: string | null
          created_at: string
          created_by: string | null
          id: string
          reason: string
          source_id: string | null
          source_type: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          amount: number
          applied_at?: string | null
          applied_settlement_id?: string | null
          booking_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          reason: string
          source_id?: string | null
          source_type: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          amount?: number
          applied_at?: string | null
          applied_settlement_id?: string | null
          booking_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          reason?: string
          source_id?: string | null
          source_type?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlement_adjustments_applied_settlement_id_fkey"
            columns: ["applied_settlement_id"]
            isOneToOne: false
            referencedRelation: "settlements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_adjustments_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_adjustments_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      settlement_items: {
        Row: {
          adjustment: number
          amount: number
          booking_id: string | null
          coupon_deduction: number
          created_at: string
          fee_amount: number
          fee_rate_bp: number | null
          id: string
          memo: string | null
          net_amount: number
          settlement_id: string
          updated_at: string
        }
        Insert: {
          adjustment?: number
          amount?: number
          booking_id?: string | null
          coupon_deduction?: number
          created_at?: string
          fee_amount?: number
          fee_rate_bp?: number | null
          id?: string
          memo?: string | null
          net_amount?: number
          settlement_id: string
          updated_at?: string
        }
        Update: {
          adjustment?: number
          amount?: number
          booking_id?: string | null
          coupon_deduction?: number
          created_at?: string
          fee_amount?: number
          fee_rate_bp?: number | null
          id?: string
          memo?: string | null
          net_amount?: number
          settlement_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlement_items_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_items_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "settlements"
            referencedColumns: ["id"]
          },
        ]
      }
      settlement_payouts: {
        Row: {
          amount: number
          attempt_count: number
          created_at: string
          failed_at: string | null
          failure_reason: string | null
          id: string
          idempotency_key: string
          paid_at: string | null
          provider: string | null
          provider_ref: string | null
          settlement_id: string
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          attempt_count?: number
          created_at?: string
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          idempotency_key: string
          paid_at?: string | null
          provider?: string | null
          provider_ref?: string | null
          settlement_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          attempt_count?: number
          created_at?: string
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          idempotency_key?: string
          paid_at?: string | null
          provider?: string | null
          provider_ref?: string | null
          settlement_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlement_payouts_settlement_id_fkey"
            columns: ["settlement_id"]
            isOneToOne: false
            referencedRelation: "settlements"
            referencedColumns: ["id"]
          },
        ]
      }
      settlements: {
        Row: {
          adjustment_amount: number
          blocked_reason: string | null
          calculated_at: string | null
          confirmed_at: string | null
          coupon_deduction: number
          created_at: string
          fee_amount: number
          fee_basis: string | null
          fee_rate_bp: number
          gross_amount: number
          id: string
          net_amount: number
          paid_at: string | null
          payable_at: string | null
          payout_amount: number | null
          period_end: string
          period_start: string
          status: string
          updated_at: string
          vendor_id: string
          vendor_note: string | null
        }
        Insert: {
          adjustment_amount?: number
          blocked_reason?: string | null
          calculated_at?: string | null
          confirmed_at?: string | null
          coupon_deduction?: number
          created_at?: string
          fee_amount?: number
          fee_basis?: string | null
          fee_rate_bp?: number
          gross_amount?: number
          id?: string
          net_amount?: number
          paid_at?: string | null
          payable_at?: string | null
          payout_amount?: number | null
          period_end: string
          period_start: string
          status?: string
          updated_at?: string
          vendor_id: string
          vendor_note?: string | null
        }
        Update: {
          adjustment_amount?: number
          blocked_reason?: string | null
          calculated_at?: string | null
          confirmed_at?: string | null
          coupon_deduction?: number
          created_at?: string
          fee_amount?: number
          fee_basis?: string | null
          fee_rate_bp?: number
          gross_amount?: number
          id?: string
          net_amount?: number
          paid_at?: string | null
          payable_at?: string | null
          payout_amount?: number | null
          period_end?: string
          period_start?: string
          status?: string
          updated_at?: string
          vendor_id?: string
          vendor_note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "settlements_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      share_links: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          last_viewed_at: string | null
          resource_id: string
          resource_type: string
          revoked_at: string | null
          token: string
          updated_at: string
          view_count: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          last_viewed_at?: string | null
          resource_id: string
          resource_type: string
          revoked_at?: string | null
          token: string
          updated_at?: string
          view_count?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          last_viewed_at?: string | null
          resource_id?: string
          resource_type?: string
          revoked_at?: string | null
          token?: string
          updated_at?: string
          view_count?: number
        }
        Relationships: []
      }
      subscription_payments: {
        Row: {
          amount: number
          billing_cycle: string | null
          created_at: string
          id: string
          membership_id: string
          status: string
          toss_payment_key: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          billing_cycle?: string | null
          created_at?: string
          id?: string
          membership_id: string
          status?: string
          toss_payment_key?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          billing_cycle?: string | null
          created_at?: string
          id?: string
          membership_id?: string
          status?: string
          toss_payment_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_payments_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      task_dependencies: {
        Row: {
          created_at: string
          created_by: string | null
          depends_on_task_id: string
          task_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          depends_on_task_id: string
          task_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          depends_on_task_id?: string
          task_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_dependencies_depends_on_task_id_fkey"
            columns: ["depends_on_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_dependencies_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_template_dependencies: {
        Row: {
          created_at: string
          depends_on_code: string
          template_code: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          depends_on_code: string
          template_code: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          depends_on_code?: string
          template_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_template_dependencies_depends_on_code_fkey"
            columns: ["depends_on_code"]
            isOneToOne: false
            referencedRelation: "task_templates"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "task_template_dependencies_template_code_fkey"
            columns: ["template_code"]
            isOneToOne: false
            referencedRelation: "task_templates"
            referencedColumns: ["code"]
          },
        ]
      }
      task_templates: {
        Row: {
          category: string
          code: string
          created_at: string
          default_owner: string | null
          description: string | null
          id: string
          offset_days: number
          title: string
          updated_at: string
        }
        Insert: {
          category: string
          code: string
          created_at?: string
          default_owner?: string | null
          description?: string | null
          id?: string
          offset_days: number
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          code?: string
          created_at?: string
          default_owner?: string | null
          description?: string | null
          id?: string
          offset_days?: number
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          assignee_id: string | null
          category: string
          completed_out_of_order: boolean
          couple_id: string
          created_at: string
          due_date: string | null
          id: string
          source: Database["public"]["Enums"]["task_source"]
          status: string
          template_code: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          category: string
          completed_out_of_order?: boolean
          couple_id: string
          created_at?: string
          due_date?: string | null
          id?: string
          source?: Database["public"]["Enums"]["task_source"]
          status?: string
          template_code?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          category?: string
          completed_out_of_order?: boolean
          couple_id?: string
          created_at?: string
          due_date?: string | null
          id?: string
          source?: Database["public"]["Enums"]["task_source"]
          status?: string
          template_code?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_template_code_fkey"
            columns: ["template_code"]
            isOneToOne: false
            referencedRelation: "task_templates"
            referencedColumns: ["code"]
          },
        ]
      }
      tickets: {
        Row: {
          assignee_id: string | null
          body: string | null
          category: string
          created_at: string
          id: string
          reporter_id: string | null
          resolution: string | null
          status: string
          subject: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          body?: string | null
          category: string
          created_at?: string
          id?: string
          reporter_id?: string | null
          resolution?: string | null
          status?: string
          subject: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          body?: string | null
          category?: string
          created_at?: string
          id?: string
          reporter_id?: string | null
          resolution?: string | null
          status?: string
          subject?: string
          updated_at?: string
        }
        Relationships: []
      }
      vendor_applications: {
        Row: {
          applicant_id: string
          biz_no_masked: string
          biz_no_verified_at: string | null
          biz_no_verified_by: string | null
          contact_phone: string
          created_at: string
          id: string
          mail_order_no: string | null
          representative_name: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["vendor_application_status"]
          submitted_at: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          applicant_id: string
          biz_no_masked: string
          biz_no_verified_at?: string | null
          biz_no_verified_by?: string | null
          contact_phone: string
          created_at?: string
          id?: string
          mail_order_no?: string | null
          representative_name: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["vendor_application_status"]
          submitted_at?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          applicant_id?: string
          biz_no_masked?: string
          biz_no_verified_at?: string | null
          biz_no_verified_by?: string | null
          contact_phone?: string
          created_at?: string
          id?: string
          mail_order_no?: string | null
          representative_name?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["vendor_application_status"]
          submitted_at?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_applications_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: true
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_availability: {
        Row: {
          created_at: string
          end_time: string
          id: string
          slot_minutes: number
          start_time: string
          updated_at: string
          vendor_id: string
          weekday: number
        }
        Insert: {
          created_at?: string
          end_time: string
          id?: string
          slot_minutes: number
          start_time: string
          updated_at?: string
          vendor_id: string
          weekday: number
        }
        Update: {
          created_at?: string
          end_time?: string
          id?: string
          slot_minutes?: number
          start_time?: string
          updated_at?: string
          vendor_id?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "vendor_availability_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_compliance_scans: {
        Row: {
          created_at: string
          findings_json: Json
          id: string
          rule_count: number
          scanned_by: string | null
          vendor_id: string
        }
        Insert: {
          created_at?: string
          findings_json?: Json
          id?: string
          rule_count: number
          scanned_by?: string | null
          vendor_id: string
        }
        Update: {
          created_at?: string
          findings_json?: Json
          id?: string
          rule_count?: number
          scanned_by?: string | null
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_compliance_scans_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_documents: {
        Row: {
          created_at: string
          doc_type: string
          id: string
          storage_path: string
          updated_at: string
          vendor_id: string
          verified_at: string | null
          verifier_id: string | null
        }
        Insert: {
          created_at?: string
          doc_type: string
          id?: string
          storage_path: string
          updated_at?: string
          vendor_id: string
          verified_at?: string | null
          verifier_id?: string | null
        }
        Update: {
          created_at?: string
          doc_type?: string
          id?: string
          storage_path?: string
          updated_at?: string
          vendor_id?: string
          verified_at?: string | null
          verifier_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_documents_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          revoked_at: string | null
          send_attempts: number
          send_failure_reason: string | null
          sent_at: string | null
          token: string
          updated_at: string
          vendor_id: string
          vendor_role: Database["public"]["Enums"]["vendor_member_role"]
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          revoked_at?: string | null
          send_attempts?: number
          send_failure_reason?: string | null
          sent_at?: string | null
          token: string
          updated_at?: string
          vendor_id: string
          vendor_role?: Database["public"]["Enums"]["vendor_member_role"]
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          revoked_at?: string | null
          send_attempts?: number
          send_failure_reason?: string | null
          sent_at?: string | null
          token?: string
          updated_at?: string
          vendor_id?: string
          vendor_role?: Database["public"]["Enums"]["vendor_member_role"]
        }
        Relationships: [
          {
            foreignKeyName: "vendor_invites_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_media: {
        Row: {
          alt_text: string | null
          created_at: string
          id: string
          sort_order: number
          storage_path: string
          type: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          alt_text?: string | null
          created_at?: string
          id?: string
          sort_order?: number
          storage_path: string
          type: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          alt_text?: string | null
          created_at?: string
          id?: string
          sort_order?: number
          storage_path?: string
          type?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_media_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_members: {
        Row: {
          created_at: string
          id: string
          permissions_json: Json
          updated_at: string
          user_id: string
          vendor_id: string
          vendor_role: Database["public"]["Enums"]["vendor_member_role"]
        }
        Insert: {
          created_at?: string
          id?: string
          permissions_json?: Json
          updated_at?: string
          user_id: string
          vendor_id: string
          vendor_role: Database["public"]["Enums"]["vendor_member_role"]
        }
        Update: {
          created_at?: string
          id?: string
          permissions_json?: Json
          updated_at?: string
          user_id?: string
          vendor_id?: string
          vendor_role?: Database["public"]["Enums"]["vendor_member_role"]
        }
        Relationships: [
          {
            foreignKeyName: "vendor_members_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_notification_prefs: {
        Row: {
          channel_flags: Json
          created_at: string
          id: string
          topic: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          channel_flags?: Json
          created_at?: string
          id?: string
          topic: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          channel_flags?: Json
          created_at?: string
          id?: string
          topic?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_notification_prefs_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_settings: {
        Row: {
          business_hours: Json
          created_at: string
          default_assignee_id: string | null
          defer_offhours: boolean
          recipient_mode: Database["public"]["Enums"]["vendor_recipient_mode"]
          updated_at: string
          vendor_id: string
        }
        Insert: {
          business_hours?: Json
          created_at?: string
          default_assignee_id?: string | null
          defer_offhours?: boolean
          recipient_mode?: Database["public"]["Enums"]["vendor_recipient_mode"]
          updated_at?: string
          vendor_id: string
        }
        Update: {
          business_hours?: Json
          created_at?: string
          default_assignee_id?: string | null
          defer_offhours?: boolean
          recipient_mode?: Database["public"]["Enums"]["vendor_recipient_mode"]
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_settings_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: true
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_templates: {
        Row: {
          created_at: string
          id: string
          kind: string
          payload_json: Json
          sort_order: number
          title: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          payload_json?: Json
          sort_order?: number
          title: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          payload_json?: Json
          sort_order?: number
          title?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_templates_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          address: string | null
          address_detail: string | null
          badge_flags: string[]
          biz_no_enc: string | null
          capacity_max: number | null
          capacity_min: number | null
          category: string
          created_at: string
          facilities: string[]
          id: string
          intro: string | null
          name: string
          region_code: string | null
          status: Database["public"]["Enums"]["vendor_status"]
          style_tags: string[]
          updated_at: string
        }
        Insert: {
          address?: string | null
          address_detail?: string | null
          badge_flags?: string[]
          biz_no_enc?: string | null
          capacity_max?: number | null
          capacity_min?: number | null
          category: string
          created_at?: string
          facilities?: string[]
          id?: string
          intro?: string | null
          name: string
          region_code?: string | null
          status?: Database["public"]["Enums"]["vendor_status"]
          style_tags?: string[]
          updated_at?: string
        }
        Update: {
          address?: string | null
          address_detail?: string | null
          badge_flags?: string[]
          biz_no_enc?: string | null
          capacity_max?: number | null
          capacity_min?: number | null
          category?: string
          created_at?: string
          facilities?: string[]
          id?: string
          intro?: string | null
          name?: string
          region_code?: string | null
          status?: Database["public"]["Enums"]["vendor_status"]
          style_tags?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      wishlists: {
        Row: {
          added_by: string
          couple_id: string
          created_at: string
          id: string
          price_at_add: number | null
          product_id: string | null
          updated_at: string
          vendor_id: string
        }
        Insert: {
          added_by: string
          couple_id: string
          created_at?: string
          id?: string
          price_at_add?: number | null
          product_id?: string | null
          updated_at?: string
          vendor_id: string
        }
        Update: {
          added_by?: string
          couple_id?: string
          created_at?: string
          id?: string
          price_at_add?: number | null
          product_id?: string | null
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wishlists_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wishlists_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wishlists_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      chat_messages_visible: {
        Row: {
          attachments: Json | null
          body: string | null
          created_at: string | null
          id: string | null
          read_at: string | null
          retracted_at: string | null
          room_id: string | null
          sender_id: string | null
          sender_type: Database["public"]["Enums"]["chat_sender_type"] | null
        }
        Insert: {
          attachments?: never
          body?: never
          created_at?: string | null
          id?: string | null
          read_at?: string | null
          retracted_at?: string | null
          room_id?: string | null
          sender_id?: string | null
          sender_type?: Database["public"]["Enums"]["chat_sender_type"] | null
        }
        Update: {
          attachments?: never
          body?: never
          created_at?: string | null
          id?: string | null
          read_at?: string | null
          retracted_at?: string | null
          room_id?: string | null
          sender_id?: string | null
          sender_type?: Database["public"]["Enums"]["chat_sender_type"] | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "chat_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      admin_actor_labels: {
        Args: { p_ids: string[] }
        Returns: {
          display_name: string
          role: string
          user_id: string
        }[]
      }
      admin_metrics: { Args: { p_from: string; p_to: string }; Returns: Json }
      admin_purge_audit: { Args: never; Returns: Json }
      attach_set_updated_at: { Args: { p_table: string }; Returns: undefined }
      booking_couple_id: { Args: { p_booking_id: string }; Returns: string }
      booking_vendor_id: { Args: { p_booking_id: string }; Returns: string }
      budget_contracted: {
        Args: { p_couple_id: string }
        Returns: {
          category: string
          contracted: number
          paid: number
        }[]
      }
      bump_post_view: { Args: { p_post_id: string }; Returns: undefined }
      can_read_qna_post: { Args: { p_post_id: string }; Returns: boolean }
      cart_active_limit: { Args: never; Returns: number }
      cart_couple_id: { Args: { p_cart_id: string }; Returns: string }
      chat_room_couple_id: { Args: { p_room_id: string }; Returns: string }
      chat_room_is_open: { Args: { p_room_id: string }; Returns: boolean }
      chat_room_vendor_id: { Args: { p_room_id: string }; Returns: string }
      consultation_couple_id: {
        Args: { p_consultation_id: string }
        Returns: string
      }
      consultation_vendor_id: {
        Args: { p_consultation_id: string }
        Returns: string
      }
      contract_booking_id: { Args: { p_contract_id: string }; Returns: string }
      coupon_issuer_vendor_id: {
        Args: { p_coupon_id: string }
        Returns: string
      }
      estimate_quote_sources: {
        Args: { p_couple_id: string; p_quote_ids?: string[] }
        Returns: {
          product_name: string
          quote_id: string
          sent_at: string
          total_amount: number
          valid_until: string
          vendor_category: string
          vendor_id: string
          vendor_name: string
        }[]
      }
      has_coupon_issue: { Args: { p_coupon_id: string }; Returns: boolean }
      has_planner_scope: {
        Args: { p_couple_id: string; p_scope: string }
        Returns: boolean
      }
      inquiry_couple_id: { Args: { p_inquiry_id: string }; Returns: string }
      invite_context: {
        Args: { p_token: string }
        Returns: {
          closed: boolean
          guest_name: string
          party_size: number
          rsvp_status: string
          wedding_date: string
        }[]
      }
      is_active_vendor: { Args: { p_vendor_id: string }; Returns: boolean }
      is_any_planner: { Args: never; Returns: boolean }
      is_any_vendor_member: { Args: never; Returns: boolean }
      is_budget_category: { Args: { p_value: string }; Returns: boolean }
      is_chat_room_member: { Args: { p_room_id: string }; Returns: boolean }
      is_content_slug: { Args: { p_value: string }; Returns: boolean }
      is_couple_member: { Args: { p_couple_id: string }; Returns: boolean }
      is_couple_owner: { Args: { p_couple_id: string }; Returns: boolean }
      is_couple_principal: { Args: { p_couple_id: string }; Returns: boolean }
      is_guest_side: { Args: { p_value: string }; Returns: boolean }
      is_inquiry_vendor: { Args: { p_inquiry_id: string }; Returns: boolean }
      is_membership_status: { Args: { p_value: string }; Returns: boolean }
      is_operator: { Args: never; Returns: boolean }
      is_planner_record: { Args: { p_planner_id: string }; Returns: boolean }
      is_published_post: { Args: { p_post_id: string }; Returns: boolean }
      is_rsvp_status: { Args: { p_value: string }; Returns: boolean }
      is_share_resource_type: { Args: { p_value: string }; Returns: boolean }
      is_tagged_vendor_member: { Args: { p_post_id: string }; Returns: boolean }
      is_vendor_member: { Args: { p_vendor_id: string }; Returns: boolean }
      is_vendor_member_of_category: {
        Args: { p_category: string }
        Returns: boolean
      }
      is_vendor_owner: { Args: { p_vendor_id: string }; Returns: boolean }
      latest_compliance_scan: {
        Args: { p_vendor_id: string }
        Returns: {
          created_at: string
          findings_json: Json
          id: string
          rule_count: number
        }[]
      }
      owns_couple_record: { Args: { p_couple_id: string }; Returns: boolean }
      owns_coupon_issue: { Args: { p_issue_id: string }; Returns: boolean }
      owns_post: { Args: { p_post_id: string }; Returns: boolean }
      owns_task: { Args: { p_task_id: string }; Returns: boolean }
      planner_contract_count: {
        Args: { p_planner_id: string }
        Returns: number
      }
      published_content: {
        Args: { p_type?: Database["public"]["Enums"]["content_post_type"] }
        Returns: {
          body_md: string
          published_at: string
          seo_json: Json
          slug: string
          title: string
          type: Database["public"]["Enums"]["content_post_type"]
          updated_at: string
        }[]
      }
      qna_post_vendor_id: { Args: { p_post_id: string }; Returns: string }
      quote_target_id: { Args: { p_quote_id: string }; Returns: string }
      recount_post_likes: { Args: { p_post_id: string }; Returns: number }
      respond_to_invite: {
        Args: { p_answer: string; p_party_size: number; p_token: string }
        Returns: {
          ok: boolean
          reason: string
        }[]
      }
      share_link_open: {
        Args: { p_token: string }
        Returns: {
          expires_at: string
          id: string
          resource_id: string
          resource_type: string
          revoked_at: string
          view_count: number
        }[]
      }
      shares_couple_with: { Args: { p_user_id: string }; Returns: boolean }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      target_couple_id: { Args: { p_target_id: string }; Returns: string }
      target_vendor_id: { Args: { p_target_id: string }; Returns: string }
      timemultirange: { Args: never; Returns: unknown }
      transparent_contract_since: {
        Args: { p_vendor_id: string }
        Returns: {
          scanned_at: string
        }[]
      }
    }
    Enums: {
      ai_feature: "planner" | "report" | "estimate" | "search"
      booking_status: "hold" | "confirmed" | "cancelled" | "fulfilled"
      chat_sender_type: "couple" | "vendor" | "system"
      commission_scope_type: "global" | "category" | "vendor"
      consultation_outcome:
        | "fulfilled"
        | "no_show_couple"
        | "no_show_vendor"
        | "undetermined"
      consultation_status:
        | "requested"
        | "approved"
        | "rejected"
        | "confirmed"
        | "completed"
        | "no_show"
        | "cancelled"
        | "disputed"
      consultation_type: "visit_consult" | "venue_tour" | "phone" | "video"
      content_post_type: "guide" | "price_report" | "glossary"
      couple_member_role: "owner" | "partner" | "planner"
      document_type: "contract" | "estimate"
      entity_event_source: "web" | "app" | "system" | "admin"
      finding_severity: "high" | "mid" | "low"
      membership_plan: "free" | "premium"
      payment_purpose: "deposit" | "balance" | "membership"
      planner_rate_scope_type: "global" | "category" | "planner"
      price_rule_type: "season" | "weekday" | "leadtime" | "occupancy"
      task_source: "auto" | "manual" | "ai"
      user_role:
        | "guest"
        | "consumer"
        | "couple_partner"
        | "planner"
        | "vendor_owner"
        | "vendor_staff"
        | "ops"
        | "admin"
      vendor_application_status:
        | "submitted"
        | "revision_requested"
        | "approved"
        | "rejected"
      vendor_member_role: "owner" | "staff"
      vendor_recipient_mode: "all" | "assignee_first" | "specific"
      vendor_status: "pending" | "active" | "suspended"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      ai_feature: ["planner", "report", "estimate", "search"],
      booking_status: ["hold", "confirmed", "cancelled", "fulfilled"],
      chat_sender_type: ["couple", "vendor", "system"],
      commission_scope_type: ["global", "category", "vendor"],
      consultation_outcome: [
        "fulfilled",
        "no_show_couple",
        "no_show_vendor",
        "undetermined",
      ],
      consultation_status: [
        "requested",
        "approved",
        "rejected",
        "confirmed",
        "completed",
        "no_show",
        "cancelled",
        "disputed",
      ],
      consultation_type: ["visit_consult", "venue_tour", "phone", "video"],
      content_post_type: ["guide", "price_report", "glossary"],
      couple_member_role: ["owner", "partner", "planner"],
      document_type: ["contract", "estimate"],
      entity_event_source: ["web", "app", "system", "admin"],
      finding_severity: ["high", "mid", "low"],
      membership_plan: ["free", "premium"],
      payment_purpose: ["deposit", "balance", "membership"],
      planner_rate_scope_type: ["global", "category", "planner"],
      price_rule_type: ["season", "weekday", "leadtime", "occupancy"],
      task_source: ["auto", "manual", "ai"],
      user_role: [
        "guest",
        "consumer",
        "couple_partner",
        "planner",
        "vendor_owner",
        "vendor_staff",
        "ops",
        "admin",
      ],
      vendor_application_status: [
        "submitted",
        "revision_requested",
        "approved",
        "rejected",
      ],
      vendor_member_role: ["owner", "staff"],
      vendor_recipient_mode: ["all", "assignee_first", "specific"],
      vendor_status: ["pending", "active", "suspended"],
    },
  },
} as const

