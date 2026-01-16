-- =====================================================
-- PLAID CONNECTIONS STORAGE
-- Run this in Supabase SQL Editor to enable persistent Plaid token storage
-- =====================================================

-- Plaid Connected Accounts
-- Stores access tokens and account info for connected banks
CREATE TABLE IF NOT EXISTS plaid_connections (
  id TEXT PRIMARY KEY,  -- Unique ID for the connection
  access_token TEXT NOT NULL,  -- Plaid access token (sensitive!)
  item_id TEXT,  -- Plaid item ID
  institution_id TEXT,  -- Plaid institution ID
  institution_name TEXT NOT NULL,  -- e.g., "Wells Fargo", "Chase"
  accounts JSONB DEFAULT '[]'::jsonb,  -- Array of account objects
  excluded_accounts JSONB DEFAULT '[]'::jsonb,  -- Account IDs to exclude from sync
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_plaid_connections_institution ON plaid_connections(institution_name);

-- QuickBooks Token Storage (optional - for QB OAuth tokens)
CREATE TABLE IF NOT EXISTS quickbooks_tokens (
  id SERIAL PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  realm_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only keep latest QB tokens
CREATE UNIQUE INDEX IF NOT EXISTS idx_qb_tokens_realm ON quickbooks_tokens(realm_id);

-- Row Level Security (RLS)
-- IMPORTANT: For server-side access, use the service_role key which bypasses RLS
-- If you want to enable RLS, uncomment and configure these policies

-- ALTER TABLE plaid_connections ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE quickbooks_tokens ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (this is the default when RLS is disabled)
-- CREATE POLICY "Service role access" ON plaid_connections FOR ALL USING (true);
-- CREATE POLICY "Service role access" ON quickbooks_tokens FOR ALL USING (true);

-- =====================================================
-- IMPORTANT SECURITY NOTES
-- =====================================================
-- 
-- 1. Use SUPABASE_SERVICE_KEY (not anon key) for backend
--    The service key bypasses RLS and has full database access
--
-- 2. NEVER expose the service key in frontend code
--    Only use it in server-side code (Railway backend)
--
-- 3. The access_token column contains sensitive Plaid tokens
--    Consider encrypting this column for extra security
--
-- 4. Add these environment variables to Railway:
--    SUPABASE_URL=https://your-project.supabase.co
--    SUPABASE_SERVICE_KEY=eyJ...your-service-role-key
--
-- =====================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_plaid_connections_updated_at ON plaid_connections;
CREATE TRIGGER update_plaid_connections_updated_at
    BEFORE UPDATE ON plaid_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- View to check connection status (without exposing tokens)
CREATE OR REPLACE VIEW plaid_connection_status AS
SELECT 
    id,
    institution_name,
    jsonb_array_length(accounts) as account_count,
    jsonb_array_length(excluded_accounts) as excluded_count,
    connected_at,
    last_synced,
    CASE 
        WHEN last_synced > NOW() - INTERVAL '24 hours' THEN 'active'
        WHEN last_synced > NOW() - INTERVAL '7 days' THEN 'stale'
        ELSE 'needs_refresh'
    END as status
FROM plaid_connections
ORDER BY connected_at DESC;

-- Check the view
-- SELECT * FROM plaid_connection_status;
