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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      anime: {
        Row: {
          anilist_id: number | null
          cover_url: string | null
          created_at: string
          episode_count: number
          id: string
          mal_id: number | null
          season_count: number
          synopsis: string | null
          title_en: string | null
          title_jp: string | null
          title_romaji: string
          updated_at: string
          year: number | null
        }
        Insert: {
          anilist_id?: number | null
          cover_url?: string | null
          created_at?: string
          episode_count?: number
          id?: string
          mal_id?: number | null
          season_count?: number
          synopsis?: string | null
          title_en?: string | null
          title_jp?: string | null
          title_romaji: string
          updated_at?: string
          year?: number | null
        }
        Update: {
          anilist_id?: number | null
          cover_url?: string | null
          created_at?: string
          episode_count?: number
          id?: string
          mal_id?: number | null
          season_count?: number
          synopsis?: string | null
          title_en?: string | null
          title_jp?: string | null
          title_romaji?: string
          updated_at?: string
          year?: number | null
        }
        Relationships: []
      }
      episode_summaries: {
        Row: {
          created_at: string
          episode_id: string
          id: string
          learning_language: string
          summary_en: string
          summary_jp: string
          updated_at: string
          used_words: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          episode_id: string
          id?: string
          learning_language?: string
          summary_en: string
          summary_jp: string
          updated_at?: string
          used_words?: Json
          user_id: string
        }
        Update: {
          created_at?: string
          episode_id?: string
          id?: string
          learning_language?: string
          summary_en?: string
          summary_jp?: string
          updated_at?: string
          used_words?: Json
          user_id?: string
        }
        Relationships: []
      }
      episode_vocab_cache: {
        Row: {
          created_at: string
          episode_id: string
          grammar: Json
          id: string
          language: string
          sentences: Json
          updated_at: string
          vocab: Json
        }
        Insert: {
          created_at?: string
          episode_id: string
          grammar?: Json
          id?: string
          language?: string
          sentences?: Json
          updated_at?: string
          vocab?: Json
        }
        Update: {
          created_at?: string
          episode_id?: string
          grammar?: Json
          id?: string
          language?: string
          sentences?: Json
          updated_at?: string
          vocab?: Json
        }
        Relationships: [
          {
            foreignKeyName: "episode_vocab_cache_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      episodes: {
        Row: {
          created_at: string
          episode_number: number
          id: string
          processing_chunks_done: number
          processing_chunks_total: number
          processing_status: Database["public"]["Enums"]["episode_status"]
          season_id: string
          title_en: string | null
          title_jp: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          episode_number: number
          id?: string
          processing_chunks_done?: number
          processing_chunks_total?: number
          processing_status?: Database["public"]["Enums"]["episode_status"]
          season_id: string
          title_en?: string | null
          title_jp?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          episode_number?: number
          id?: string
          processing_chunks_done?: number
          processing_chunks_total?: number
          processing_status?: Database["public"]["Enums"]["episode_status"]
          season_id?: string
          title_en?: string | null
          title_jp?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "episodes_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      flashcard_push_deliveries: {
        Row: {
          created_at: string
          device_id: string
          example_sentence: string | null
          id: string
          learning_language: string
          level: string | null
          meaning: string | null
          reading: string | null
          review_token: string
          reviewed_at: string | null
          slot: string
          status: string
          user_id: string
          word: string
        }
        Insert: {
          created_at?: string
          device_id: string
          example_sentence?: string | null
          id?: string
          learning_language: string
          level?: string | null
          meaning?: string | null
          reading?: string | null
          review_token?: string
          reviewed_at?: string | null
          slot: string
          status?: string
          user_id: string
          word: string
        }
        Update: {
          created_at?: string
          device_id?: string
          example_sentence?: string | null
          id?: string
          learning_language?: string
          level?: string | null
          meaning?: string | null
          reading?: string | null
          review_token?: string
          reviewed_at?: string | null
          slot?: string
          status?: string
          user_id?: string
          word?: string
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_push_deliveries_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "flashcard_push_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      flashcard_push_devices: {
        Row: {
          cards_per_day: number
          cards_per_hour: number
          enabled: boolean
          end_hour: number
          id: string
          start_hour: number
          timezone: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cards_per_day?: number
          cards_per_hour?: number
          enabled?: boolean
          end_hour?: number
          id?: string
          start_hour?: number
          timezone?: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cards_per_day?: number
          cards_per_hour?: number
          enabled?: boolean
          end_hour?: number
          id?: string
          start_hour?: number
          timezone?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      flashcard_push_jobs: {
        Row: {
          claimed_at: string | null
          created_at: string
          id: string
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          id?: string
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          country: string | null
          created_at: string
          display_name: string | null
          id: string
          jlpt_level: Database["public"]["Enums"]["jlpt_level"]
          learning_language: string
          placement_done: boolean
          study_streak: number
          total_words_known: number
          ui_language: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          country?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          jlpt_level?: Database["public"]["Enums"]["jlpt_level"]
          learning_language?: string
          placement_done?: boolean
          study_streak?: number
          total_words_known?: number
          ui_language?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          country?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          jlpt_level?: Database["public"]["Enums"]["jlpt_level"]
          learning_language?: string
          placement_done?: boolean
          study_streak?: number
          total_words_known?: number
          ui_language?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      quiz_results: {
        Row: {
          created_at: string
          id: string
          learning_language: string
          quiz_kind: Database["public"]["Enums"]["quiz_type"]
          session_id: string
          user_id: string
          was_correct: boolean
          word: string
        }
        Insert: {
          created_at?: string
          id?: string
          learning_language?: string
          quiz_kind: Database["public"]["Enums"]["quiz_type"]
          session_id: string
          user_id: string
          was_correct: boolean
          word: string
        }
        Update: {
          created_at?: string
          id?: string
          learning_language?: string
          quiz_kind?: Database["public"]["Enums"]["quiz_type"]
          session_id?: string
          user_id?: string
          was_correct?: boolean
          word?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_results_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      seasons: {
        Row: {
          anime_id: string
          created_at: string
          episode_count: number
          id: string
          season_number: number
          title: string | null
        }
        Insert: {
          anime_id: string
          created_at?: string
          episode_count?: number
          id?: string
          season_number: number
          title?: string | null
        }
        Update: {
          anime_id?: string
          created_at?: string
          episode_count?: number
          id?: string
          season_number?: number
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "seasons_anime_id_fkey"
            columns: ["anime_id"]
            isOneToOne: false
            referencedRelation: "anime"
            referencedColumns: ["id"]
          },
        ]
      }
      study_chunk_words: {
        Row: {
          chunk_id: string
          created_at: string
          example_sentence_en: string | null
          example_sentence_jp: string | null
          id: string
          level: string | null
          meaning: string | null
          part_of_speech: string | null
          position: number
          reading: string | null
          word: string
        }
        Insert: {
          chunk_id: string
          created_at?: string
          example_sentence_en?: string | null
          example_sentence_jp?: string | null
          id?: string
          level?: string | null
          meaning?: string | null
          part_of_speech?: string | null
          position: number
          reading?: string | null
          word: string
        }
        Update: {
          chunk_id?: string
          created_at?: string
          example_sentence_en?: string | null
          example_sentence_jp?: string | null
          id?: string
          level?: string | null
          meaning?: string | null
          part_of_speech?: string | null
          position?: number
          reading?: string | null
          word?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_chunk_words_chunk_id_fkey"
            columns: ["chunk_id"]
            isOneToOne: false
            referencedRelation: "study_chunks"
            referencedColumns: ["id"]
          },
        ]
      }
      study_chunks: {
        Row: {
          chunk_index: number
          created_at: string
          episode_id: string
          id: string
          learning_language: string
          studied_at: string | null
          updated_at: string
          user_id: string
          word_count: number
        }
        Insert: {
          chunk_index: number
          created_at?: string
          episode_id: string
          id?: string
          learning_language?: string
          studied_at?: string | null
          updated_at?: string
          user_id: string
          word_count?: number
        }
        Update: {
          chunk_index?: number
          created_at?: string
          episode_id?: string
          id?: string
          learning_language?: string
          studied_at?: string | null
          updated_at?: string
          user_id?: string
          word_count?: number
        }
        Relationships: []
      }
      study_sessions: {
        Row: {
          chunk_id: string | null
          episode_id: string | null
          finished_at: string | null
          id: string
          learning_language: string
          mode: Database["public"]["Enums"]["study_mode"]
          started_at: string
          user_id: string
          words_mastered: number
          words_studied: number
        }
        Insert: {
          chunk_id?: string | null
          episode_id?: string | null
          finished_at?: string | null
          id?: string
          learning_language?: string
          mode: Database["public"]["Enums"]["study_mode"]
          started_at?: string
          user_id: string
          words_mastered?: number
          words_studied?: number
        }
        Update: {
          chunk_id?: string | null
          episode_id?: string | null
          finished_at?: string | null
          id?: string
          learning_language?: string
          mode?: Database["public"]["Enums"]["study_mode"]
          started_at?: string
          user_id?: string
          words_mastered?: number
          words_studied?: number
        }
        Relationships: [
          {
            foreignKeyName: "study_sessions_chunk_id_fkey"
            columns: ["chunk_id"]
            isOneToOne: false
            referencedRelation: "study_chunks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_sessions_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      subtitles: {
        Row: {
          created_at: string
          episode_id: string
          id: string
          language: string
          source: Database["public"]["Enums"]["subtitle_source"]
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          episode_id: string
          id?: string
          language?: string
          source: Database["public"]["Enums"]["subtitle_source"]
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          episode_id?: string
          id?: string
          language?: string
          source?: Database["public"]["Enums"]["subtitle_source"]
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subtitles_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      user_anime: {
        Row: {
          added_at: string
          anime_id: string
          id: string
          learning_language: string
          position: number
          user_id: string
        }
        Insert: {
          added_at?: string
          anime_id: string
          id?: string
          learning_language?: string
          position?: number
          user_id: string
        }
        Update: {
          added_at?: string
          anime_id?: string
          id?: string
          learning_language?: string
          position?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_anime_anime_id_fkey"
            columns: ["anime_id"]
            isOneToOne: false
            referencedRelation: "anime"
            referencedColumns: ["id"]
          },
        ]
      }
      user_language_progress: {
        Row: {
          created_at: string
          id: string
          learning_language: string
          level: string
          placement_done: boolean
          study_streak: number
          total_words_known: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          learning_language: string
          level?: string
          placement_done?: boolean
          study_streak?: number
          total_words_known?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          learning_language?: string
          level?: string
          placement_done?: boolean
          study_streak?: number
          total_words_known?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_word_state: {
        Row: {
          correct_streak: number
          created_at: string
          id: string
          known_source: string | null
          last_reviewed_at: string | null
          learning_language: string
          level: string | null
          marked_known_at: string | null
          preference: Database["public"]["Enums"]["word_preference"]
          reading: string | null
          srs_due_at: string | null
          srs_level: number
          state: Database["public"]["Enums"]["word_state"]
          updated_at: string
          user_id: string
          word: string
        }
        Insert: {
          correct_streak?: number
          created_at?: string
          id?: string
          known_source?: string | null
          last_reviewed_at?: string | null
          learning_language?: string
          level?: string | null
          marked_known_at?: string | null
          preference?: Database["public"]["Enums"]["word_preference"]
          reading?: string | null
          srs_due_at?: string | null
          srs_level?: number
          state?: Database["public"]["Enums"]["word_state"]
          updated_at?: string
          user_id: string
          word: string
        }
        Update: {
          correct_streak?: number
          created_at?: string
          id?: string
          known_source?: string | null
          last_reviewed_at?: string | null
          learning_language?: string
          level?: string | null
          marked_known_at?: string | null
          preference?: Database["public"]["Enums"]["word_preference"]
          reading?: string | null
          srs_due_at?: string | null
          srs_level?: number
          state?: Database["public"]["Enums"]["word_state"]
          updated_at?: string
          user_id?: string
          word?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      review_flashcard_delivery: {
        Args: { delivery_id: string; owner_id: string; remembered: boolean }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "user"
      episode_status: "not_processed" | "processing" | "ready" | "failed"
      jlpt_level: "N5" | "N4" | "N3" | "N2" | "N1" | "none"
      quiz_type: "jp_to_meaning" | "meaning_to_jp" | "fill_blank"
      study_mode: "review" | "quiz"
      subtitle_source: "auto" | "upload"
      word_preference: "study" | "kanji_only" | "skip"
      word_state: "unknown" | "learning" | "known"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      episode_status: ["not_processed", "processing", "ready", "failed"],
      jlpt_level: ["N5", "N4", "N3", "N2", "N1", "none"],
      quiz_type: ["jp_to_meaning", "meaning_to_jp", "fill_blank"],
      study_mode: ["review", "quiz"],
      subtitle_source: ["auto", "upload"],
      word_preference: ["study", "kanji_only", "skip"],
      word_state: ["unknown", "learning", "known"],
    },
  },
} as const
