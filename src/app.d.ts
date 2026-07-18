import type { SupabaseClient } from '@supabase/supabase-js';

declare global {
	namespace App {
		interface Locals {
			supabase: SupabaseClient;
			safeGetClaims: () => Promise<Record<string, unknown> | null>;
		}
		interface Platform {
			env?: unknown;
		}
	}
}

export {};
