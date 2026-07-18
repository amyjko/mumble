import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/database.types';

declare global {
	namespace App {
		interface Locals {
			supabase: SupabaseClient<Database>;
			safeGetClaims: () => Promise<Record<string, unknown> | null>;
		}
		interface Platform {
			env?: unknown;
		}
	}
}

export {};
