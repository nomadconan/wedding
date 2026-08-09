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
          cost_estimate: number | null
          created_at: string
          feature: Database["public"]["Enums"]["ai_feature"]
          id: string
          model: string | null
          prompt_version: string | null
          retry_count: number
          updated_at: string
          validation_result: string | null
        }
        Insert: {
          cost_estimate?: number | null
          created_at?: string
          feature: Database["public"]["Enums"]["ai_feature"]
          id?: string
          model?: string | null
          prompt_version?: string | null
          retry_count?: number
          updated_at?: string
          validation_result?: string | null
        }
        Update: {
          cost_estimate?: number | null
          created_at?: string
          feature?: Database["public"]["Enums"]["ai_feature"]
          id?: string
          model?: string | null
          prompt_version?: string | null
          retry_count?: number
          updated_at?: string
          validation_result?: string | null
        }
        Relationships: []
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
          target_id?: string | null
          target_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      bookings: {
        Row: {
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
          status: string
          updated_at: string
        }
        Insert: {
          couple_id: string
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
        }
        Update: {
          couple_id?: string
          created_at?: string
          id?: string
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
      contract_signatures: {
        Row: {
          contract_id: string
          created_at: string
          id: string
          ip_hash: string | null
          signed_at: string | null
          signer_id: string | null
          signer_role: string
          updated_at: string
          verification_method: string | null
        }
        Insert: {
          contract_id: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          signed_at?: string | null
          signer_id?: string | null
          signer_role: string
          updated_at?: string
          verification_method?: string | null
        }
        Update: {
          contract_id?: string
          created_at?: string
          id?: string
          ip_hash?: string | null
          signed_at?: string | null
          signer_id?: string | null
          signer_role?: string
          updated_at?: string
          verification_method?: string | null
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
      contracts: {
        Row: {
          booking_id: string
          clauses_json: Json
          created_at: string
          id: string
          issued_at: string | null
          pdf_path: string | null
          status: string
          template_version: string | null
          updated_at: string
        }
        Insert: {
          booking_id: string
          clauses_json?: Json
          created_at?: string
          id?: string
          issued_at?: string | null
          pdf_path?: string | null
          status?: string
          template_version?: string | null
          updated_at?: string
        }
        Update: {
          booking_id?: string
          clauses_json?: Json
          created_at?: string
          id?: string
          issued_at?: string | null
          pdf_path?: string | null
          status?: string
          template_version?: string | null
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
      data_deletion_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          requested_at: string
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
          created_at: string
          evidence_paths: string[]
          id: string
          raised_by: string | null
          reason_code: string
          resolution_json: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          evidence_paths?: string[]
          id?: string
          raised_by?: string | null
          reason_code: string
          resolution_json?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          evidence_paths?: string[]
          id?: string
          raised_by?: string | null
          reason_code?: string
          resolution_json?: Json | null
          status?: string
          updated_at?: string
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
          created_at: string
          held_amount: number
          hold_reason: string | null
          id: string
          payment_id: string
          release_condition: Json
          released_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          held_amount: number
          hold_reason?: string | null
          id?: string
          payment_id: string
          release_condition?: Json
          released_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          held_amount?: number
          hold_reason?: string | null
          id?: string
          payment_id?: string
          release_condition?: Json
          released_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "escrow_holds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
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
          name: string
          party_size: number
          rsvp_status: string
          side: string | null
          updated_at: string
        }
        Insert: {
          contact_hash?: string | null
          couple_id: string
          created_at?: string
          id?: string
          name: string
          party_size?: number
          rsvp_status?: string
          side?: string | null
          updated_at?: string
        }
        Update: {
          contact_hash?: string | null
          couple_id?: string
          created_at?: string
          id?: string
          name?: string
          party_size?: number
          rsvp_status?: string
          side?: string | null
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
          couple_id: string
          created_at: string
          id: string
          request_json: Json
          status: string
          updated_at: string
        }
        Insert: {
          couple_id: string
          created_at?: string
          id?: string
          request_json?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          couple_id?: string
          created_at?: string
          id?: string
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
          started_at: string | null
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
          started_at?: string | null
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
          started_at?: string | null
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
          channel: string
          created_at: string
          id: string
          payload_json: Json
          read_at: string | null
          sent_at: string | null
          topic: string
          updated_at: string
          user_id: string
        }
        Insert: {
          channel: string
          created_at?: string
          id?: string
          payload_json?: Json
          read_at?: string | null
          sent_at?: string | null
          topic: string
          updated_at?: string
          user_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          id?: string
          payload_json?: Json
          read_at?: string | null
          sent_at?: string | null
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
      payments: {
        Row: {
          amount: number
          booking_id: string | null
          created_at: string
          id: string
          idempotency_key: string | null
          membership_id: string | null
          purpose: Database["public"]["Enums"]["payment_purpose"]
          raw_webhook_json: Json | null
          status: string
          toss_payment_key: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          booking_id?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          membership_id?: string | null
          purpose: Database["public"]["Enums"]["payment_purpose"]
          raw_webhook_json?: Json | null
          status?: string
          toss_payment_key?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          booking_id?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          membership_id?: string | null
          purpose?: Database["public"]["Enums"]["payment_purpose"]
          raw_webhook_json?: Json | null
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
        ]
      }
      penalty_rules: {
        Row: {
          basis_ref: string | null
          cancel_window: string
          category: string
          created_at: string
          id: string
          standard_rate: number
          updated_at: string
          version: string
        }
        Insert: {
          basis_ref?: string | null
          cancel_window: string
          category: string
          created_at?: string
          id?: string
          standard_rate: number
          updated_at?: string
          version: string
        }
        Update: {
          basis_ref?: string | null
          cancel_window?: string
          category?: string
          created_at?: string
          id?: string
          standard_rate?: number
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
      quote_items: {
        Row: {
          amount: number
          category_code: string
          created_at: string
          id: string
          is_mandatory: boolean
          is_option: boolean
          label: string
          quote_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          category_code: string
          created_at?: string
          id?: string
          is_mandatory?: boolean
          is_option?: boolean
          label: string
          quote_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          category_code?: string
          created_at?: string
          id?: string
          is_mandatory?: boolean
          is_option?: boolean
          label?: string
          quote_id?: string
          updated_at?: string
        }
        Relationships: [
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
          created_at: string
          id: string
          inquiry_target_id: string
          product_id: string | null
          status: string
          total_amount: number
          updated_at: string
          valid_until: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          inquiry_target_id: string
          product_id?: string | null
          status?: string
          total_amount: number
          updated_at?: string
          valid_until?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          inquiry_target_id?: string
          product_id?: string | null
          status?: string
          total_amount?: number
          updated_at?: string
          valid_until?: string | null
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
          review_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          reason_code: string
          reporter_id?: string | null
          review_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          reason_code?: string
          reporter_id?: string | null
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
          id: string
          score_fulfillment: number | null
          score_price: number | null
          score_response: number | null
          status: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          body?: string | null
          booking_id: string
          couple_id: string
          created_at?: string
          disclosed_amount?: number | null
          id?: string
          score_fulfillment?: number | null
          score_price?: number | null
          score_response?: number | null
          status?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          body?: string | null
          booking_id?: string
          couple_id?: string
          created_at?: string
          disclosed_amount?: number | null
          id?: string
          score_fulfillment?: number | null
          score_price?: number | null
          score_response?: number | null
          status?: string
          updated_at?: string
          vendor_id?: string
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
      settlement_items: {
        Row: {
          adjustment: number
          amount: number
          booking_id: string | null
          created_at: string
          id: string
          memo: string | null
          settlement_id: string
          updated_at: string
        }
        Insert: {
          adjustment?: number
          amount?: number
          booking_id?: string | null
          created_at?: string
          id?: string
          memo?: string | null
          settlement_id: string
          updated_at?: string
        }
        Update: {
          adjustment?: number
          amount?: number
          booking_id?: string | null
          created_at?: string
          id?: string
          memo?: string | null
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
      settlements: {
        Row: {
          created_at: string
          fee_amount: number
          fee_rate: number
          gross_amount: number
          id: string
          net_amount: number
          period_end: string
          period_start: string
          status: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          created_at?: string
          fee_amount?: number
          fee_rate: number
          gross_amount?: number
          id?: string
          net_amount?: number
          period_end: string
          period_start: string
          status?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          created_at?: string
          fee_amount?: number
          fee_rate?: number
          gross_amount?: number
          id?: string
          net_amount?: number
          period_end?: string
          period_start?: string
          status?: string
          updated_at?: string
          vendor_id?: string
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
          expires_at: string
          id: string
          resource_id: string
          resource_type: string
          token: string
          updated_at: string
          view_count: number
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          resource_id: string
          resource_type: string
          token: string
          updated_at?: string
          view_count?: number
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          resource_id?: string
          resource_type?: string
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
      task_templates: {
        Row: {
          category: string
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
          couple_id: string
          created_at: string
          due_date: string | null
          id: string
          source: Database["public"]["Enums"]["task_source"]
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          category: string
          couple_id: string
          created_at?: string
          due_date?: string | null
          id?: string
          source?: Database["public"]["Enums"]["task_source"]
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          category?: string
          couple_id?: string
          created_at?: string
          due_date?: string | null
          id?: string
          source?: Database["public"]["Enums"]["task_source"]
          status?: string
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
      [_ in never]: never
    }
    Functions: {
      attach_set_updated_at: { Args: { p_table: string }; Returns: undefined }
      cart_couple_id: { Args: { p_cart_id: string }; Returns: string }
      has_planner_scope: {
        Args: { p_couple_id: string; p_scope: string }
        Returns: boolean
      }
      is_any_planner: { Args: never; Returns: boolean }
      is_any_vendor_member: { Args: never; Returns: boolean }
      is_couple_member: { Args: { p_couple_id: string }; Returns: boolean }
      is_couple_owner: { Args: { p_couple_id: string }; Returns: boolean }
      is_couple_principal: { Args: { p_couple_id: string }; Returns: boolean }
      is_planner_record: { Args: { p_planner_id: string }; Returns: boolean }
      is_vendor_member: { Args: { p_vendor_id: string }; Returns: boolean }
      is_vendor_member_of_category: {
        Args: { p_category: string }
        Returns: boolean
      }
      is_vendor_owner: { Args: { p_vendor_id: string }; Returns: boolean }
      owns_couple_record: { Args: { p_couple_id: string }; Returns: boolean }
      shares_couple_with: { Args: { p_user_id: string }; Returns: boolean }
      timemultirange: { Args: never; Returns: unknown }
    }
    Enums: {
      ai_feature: "planner" | "report" | "estimate"
      booking_status: "hold" | "confirmed" | "cancelled" | "fulfilled"
      commission_scope_type: "global" | "category" | "vendor"
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
      ai_feature: ["planner", "report", "estimate"],
      booking_status: ["hold", "confirmed", "cancelled", "fulfilled"],
      commission_scope_type: ["global", "category", "vendor"],
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
      vendor_status: ["pending", "active", "suspended"],
    },
  },
} as const

