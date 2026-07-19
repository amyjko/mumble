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
      participant_locations: {
        Row: {
          config_key: string
          identity_id: string
          room_id: string
          updated_at: string
          x: number
          y: number
        }
        Insert: {
          config_key: string
          identity_id: string
          room_id: string
          updated_at?: string
          x: number
          y: number
        }
        Update: {
          config_key?: string
          identity_id?: string
          room_id?: string
          updated_at?: string
          x?: number
          y?: number
        }
        Relationships: [
          {
            foreignKeyName: "participant_locations_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          emoji: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          emoji: string
          id: string
          name: string
          updated_at?: string
        }
        Update: {
          emoji?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      reserved_room_names: {
        Row: {
          name: string
        }
        Insert: {
          name: string
        }
        Update: {
          name?: string
        }
        Relationships: []
      }
      room_configurations: {
        Row: {
          id: string
          name: string
          room_id: string
          snapshot: Json
        }
        Insert: {
          id: string
          name: string
          room_id: string
          snapshot: Json
        }
        Update: {
          id?: string
          name?: string
          room_id?: string
          snapshot?: Json
        }
        Relationships: [
          {
            foreignKeyName: "room_configurations_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_members: {
        Row: {
          created_at: string
          hello: string | null
          identity_id: string
          role: string
          room_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          hello?: string | null
          identity_id: string
          role?: string
          room_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          hello?: string | null
          identity_id?: string
          role?: string
          room_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_members_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_objects: {
        Row: {
          border: Json
          clip: Json
          created_at: string
          creator_id: string
          hidden: boolean
          id: string
          payload: Json
          permission: string
          room_id: string
          transform: Json
          type: string
          updated_at: string
        }
        Insert: {
          border: Json
          clip: Json
          created_at?: string
          creator_id: string
          hidden?: boolean
          id: string
          payload?: Json
          permission?: string
          room_id: string
          transform: Json
          type: string
          updated_at?: string
        }
        Update: {
          border?: Json
          clip?: Json
          created_at?: string
          creator_id?: string
          hidden?: boolean
          id?: string
          payload?: Json
          permission?: string
          room_id?: string
          transform?: Json
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_objects_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_participants: {
        Row: {
          away: boolean
          clip: Json
          emoji: string
          fake: boolean
          id: string
          location: Json
          muted: boolean
          name: string
          room_id: string
          rotation: number
          size: Json
        }
        Insert: {
          away?: boolean
          clip: Json
          emoji: string
          fake?: boolean
          id: string
          location: Json
          muted?: boolean
          name: string
          room_id: string
          rotation?: number
          size: Json
        }
        Update: {
          away?: boolean
          clip?: Json
          emoji?: string
          fake?: boolean
          id?: string
          location?: Json
          muted?: boolean
          name?: string
          room_id?: string
          rotation?: number
          size?: Json
        }
        Relationships: [
          {
            foreignKeyName: "room_participants_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_state: {
        Row: {
          active_config: string | null
          audio_holders: string[]
          background: string
          border_default: number
          create_permission: string
          description: string
          max_audio: number
          max_av: number
          max_participants: number
          placers: Json
          queue: string[]
          room_id: string
          title: string
          transport: string
          updated_at: string
          video_holders: string[]
        }
        Insert: {
          active_config?: string | null
          audio_holders?: string[]
          background?: string
          border_default?: number
          create_permission?: string
          description?: string
          max_audio?: number
          max_av?: number
          max_participants?: number
          placers?: Json
          queue?: string[]
          room_id: string
          title?: string
          transport?: string
          updated_at?: string
          video_holders?: string[]
        }
        Update: {
          active_config?: string | null
          audio_holders?: string[]
          background?: string
          border_default?: number
          create_permission?: string
          description?: string
          max_audio?: number
          max_av?: number
          max_participants?: number
          placers?: Json
          queue?: string[]
          room_id?: string
          title?: string
          transport?: string
          updated_at?: string
          video_holders?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "room_state_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: true
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      rooms: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_room_state: { Args: { p_room_id: string }; Returns: Json }
      is_admitted_member: { Args: { target_room: string }; Returns: boolean }
      is_host: { Args: { target_room: string }; Returns: boolean }
      is_member: { Args: { target_room: string }; Returns: boolean }
      join_room: {
        Args: { p_name: string }
        Returns: {
          out_is_host: boolean
          out_room_id: string
        }[]
      }
      save_room_state: {
        Args: { p_expected_version: number; p_room_id: string; p_state: Json }
        Returns: number
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

