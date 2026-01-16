const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Supabase Configuration (for persistent token storage)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service key for server-side
let supabase = null;

function initSupabase() {
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY && !supabase) {
        try {
            supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
            console.log('✓ Supabase initialized for persistent storage');
        } catch (err) {
            console.log('Supabase init error:', err.message);
        }
    } else if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        console.log('⚠️ Supabase not configured - using local file storage (tokens may be lost on redeploy)');
    }
}

// QuickBooks OAuth Configuration
const QB_CLIENT_ID = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const QB_REDIRECT_URI = process.env.QB_REDIRECT_URI || 'https://asap-financial-dashboard-backend-production-b444.up.railway.app/api/quickbooks/callback';
const QB_ENVIRONMENT = process.env.QB_ENVIRONMENT || 'production';

// Anthropic AI for categorization - initialized later
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
let anthropic = null;

function initAnthropic() {
    if (ANTHROPIC_API_KEY && !anthropic) {
        try {
            anthropic = new Anthropic({ 
                apiKey: ANTHROPIC_API_KEY,
                fetch: fetch
            });
            console.log('✓ Anthropic AI initialized');
        } catch (err) {
            console.log('Anthropic init error:', err.message);
        }
    }
}

const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_API_BASE = QB_ENVIRONMENT === 'sandbox' 
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

// Token storage
let tokens = {
    access_token: null,
    refresh_token: null,
    realm_id: null,
    expires_at: null
};

// Category cache
let categoryCache = {
    categories: [],
    lastFetched: null
};

// Learned rules cache (loaded from memory, should come from Supabase in production)
let learnedRules = [];

const TOKEN_FILE = './qb_tokens.json';
const RULES_FILE = './learned_rules.json';

async function loadTokens() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const data = fs.readFileSync(TOKEN_FILE, 'utf8');
            tokens = JSON.parse(data);
            console.log('✓ Loaded saved tokens');
        }
    } catch (err) {
        console.log('No saved tokens found');
    }
}

async function saveTokens() {
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    } catch (err) {
        console.error('Error saving tokens:', err);
    }
}

async function loadRules() {
    try {
        if (fs.existsSync(RULES_FILE)) {
            const data = fs.readFileSync(RULES_FILE, 'utf8');
            learnedRules = JSON.parse(data);
            console.log(`✓ Loaded ${learnedRules.length} learned rules`);
        }
    } catch (err) {
        console.log('No learned rules found');
    }
}

async function saveRules() {
    try {
        fs.writeFileSync(RULES_FILE, JSON.stringify(learnedRules, null, 2));
    } catch (err) {
        console.error('Error saving rules:', err);
    }
}

// ========== AUTH ENDPOINTS ==========

app.get('/api/quickbooks/auth', (req, res) => {
    const scopes = 'com.intuit.quickbooks.accounting';
    const authUrl = `${QB_AUTH_URL}?client_id=${QB_CLIENT_ID}&response_type=code&scope=${scopes}&redirect_uri=${encodeURIComponent(QB_REDIRECT_URI)}&state=security_token`;
    res.json({ url: authUrl });
});

app.get('/api/quickbooks/callback', async (req, res) => {
    const { code, realmId } = req.query;
    
    if (!code) {
        return res.status(400).send('Missing authorization code');
    }

    try {
        const authHeader = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
        
        const response = await fetch(QB_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${authHeader}`
            },
            body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(QB_REDIRECT_URI)}`
        });

        const tokenData = await response.json();

        if (tokenData.access_token) {
            tokens = {
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                realm_id: realmId,
                expires_at: Date.now() + (tokenData.expires_in * 1000)
            };
            await saveTokens();
            console.log('✓ QuickBooks connected successfully');
            
            // Fetch and cache categories on connect
            await fetchAndCacheCategories();
            
            const frontendUrl = process.env.FRONTEND_URL || 'https://cute-cat-d9631c.netlify.app';
            res.redirect(`${frontendUrl}/admin/financials?connected=true`);
        } else {
            console.error('Token error:', tokenData);
            res.status(400).send('Failed to get access token');
        }
    } catch (err) {
        console.error('OAuth error:', err);
        res.status(500).send('OAuth error: ' + err.message);
    }
});

app.get('/api/quickbooks/status', (req, res) => {
    res.json({
        connected: !!tokens.access_token,
        company_id: tokens.realm_id,
        ai_enabled: !!anthropic
    });
});

// DEBUG: Check which environment variables are set (no values shown for security)
app.get('/api/debug/env', (req, res) => {
    res.json({
        vars_set: {
            QB_CLIENT_ID: !!process.env.QB_CLIENT_ID,
            QB_CLIENT_SECRET: !!process.env.QB_CLIENT_SECRET,
            QB_REDIRECT_URI: !!process.env.QB_REDIRECT_URI,
            QB_ENVIRONMENT: process.env.QB_ENVIRONMENT || '(not set, defaults to production)',
            ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
            PLAID_CLIENT_ID: !!process.env.PLAID_CLIENT_ID,
            PLAID_SECRET: !!process.env.PLAID_SECRET,
            PLAID_ENV: process.env.PLAID_ENV || '(not set, defaults to sandbox)',
            FRONTEND_URL: !!process.env.FRONTEND_URL,
            PORT: process.env.PORT || '(not set, defaults to 3001)'
        },
        plaid_client_id_length: process.env.PLAID_CLIENT_ID ? process.env.PLAID_CLIENT_ID.length : 0,
        plaid_secret_length: process.env.PLAID_SECRET ? process.env.PLAID_SECRET.length : 0,
        anthropic_key_length: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.length : 0
    });
});

app.post('/api/quickbooks/disconnect', (req, res) => {
    tokens = { access_token: null, refresh_token: null, realm_id: null, expires_at: null };
    try { fs.unlinkSync(TOKEN_FILE); } catch (e) {}
    res.json({ success: true });
});

// ========== TOKEN REFRESH ==========

async function refreshAccessToken() {
    if (!tokens.refresh_token) {
        throw new Error('No refresh token available');
    }

    const authHeader = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(QB_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${authHeader}`
        },
        body: `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`
    });

    const tokenData = await response.json();

    if (tokenData.access_token) {
        tokens.access_token = tokenData.access_token;
        tokens.refresh_token = tokenData.refresh_token || tokens.refresh_token;
        tokens.expires_at = Date.now() + (tokenData.expires_in * 1000);
        await saveTokens();
        console.log('✓ Token refreshed');
    } else {
        throw new Error('Failed to refresh token');
    }
}

async function ensureValidToken() {
    if (!tokens.access_token) {
        throw new Error('Not authenticated');
    }
    
    if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) {
        await refreshAccessToken();
    }
}

// ========== QUICKBOOKS API CALLS ==========

async function qbApiCall(endpoint, method = 'GET', body = null) {
    await ensureValidToken();
    
    const url = `${QB_API_BASE}/v3/company/${tokens.realm_id}${endpoint}`;
    
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${tokens.access_token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`QB API Error (${endpoint}):`, errorText);
        throw new Error(`QuickBooks API error: ${response.status} - ${errorText}`);
    }

    return response.json();
}

async function fetchAllRecords(entityType, whereClause = '') {
    const allRecords = [];
    let startPosition = 1;
    const maxResults = 1000;
    let hasMore = true;
    
    while (hasMore) {
        try {
            const query = `SELECT * FROM ${entityType}${whereClause ? ' WHERE ' + whereClause : ''} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
            const result = await qbApiCall(`/query?query=${encodeURIComponent(query)}`);
            
            const records = result.QueryResponse?.[entityType] || [];
            allRecords.push(...records);
            
            if (records.length < maxResults) {
                hasMore = false;
            } else {
                startPosition += maxResults;
            }
            
            if (startPosition > 10000) {
                hasMore = false;
            }
        } catch (err) {
            console.log(`  Note: Error fetching ${entityType}:`, err.message);
            hasMore = false;
        }
    }
    
    return allRecords;
}

// ========== CATEGORIES ==========

async function fetchAndCacheCategories() {
    console.log('  → Fetching QB Categories...');
    const accounts = await fetchAllRecords('Account');
    
    // Filter to expense-type accounts
    const expenseAccounts = accounts.filter(a => 
        ['Expense', 'Cost of Goods Sold', 'Other Expense', 'Other Current Liability'].includes(a.AccountType)
    );
    
    categoryCache = {
        categories: expenseAccounts.map(a => ({
            id: a.Id,
            name: a.Name,
            fullName: a.FullyQualifiedName || a.Name,
            type: a.AccountType,
            subType: a.AccountSubType,
            active: a.Active
        })),
        lastFetched: Date.now()
    };
    
    console.log(`     Cached ${categoryCache.categories.length} expense categories`);
    return categoryCache.categories;
}

app.get('/api/quickbooks/categories', async (req, res) => {
    try {
        if (!tokens.access_token) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        
        // Refresh if older than 1 hour
        if (!categoryCache.lastFetched || Date.now() - categoryCache.lastFetched > 3600000) {
            await fetchAndCacheCategories();
        }
        
        res.json({ categories: categoryCache.categories });
    } catch (err) {
        console.error('Category fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== AI CATEGORIZATION ==========

function findMatchingRule(description, vendorName) {
    const searchText = `${description} ${vendorName}`.toLowerCase();
    
    for (const rule of learnedRules) {
        const pattern = rule.pattern.toLowerCase();
        let matched = false;
        
        if (rule.patternType === 'exact') {
            matched = searchText === pattern;
        } else if (rule.patternType === 'starts_with') {
            matched = searchText.startsWith(pattern);
        } else {
            // Default: contains
            matched = searchText.includes(pattern);
        }
        
        if (matched) {
            return {
                categoryId: rule.categoryId,
                categoryName: rule.categoryName,
                confidence: rule.confidence || 1.0,
                source: 'learned_rule',
                ruleId: rule.id
            };
        }
    }
    
    return null;
}

async function aiCategorize(transaction, categories) {
    if (!anthropic) {
        return null;
    }
    
    const categoryList = categories.map(c => `- ${c.name} (ID: ${c.id})`).join('\n');
    
    const prompt = `You are a bookkeeper categorizing a business expense transaction.

Transaction details:
- Description: ${transaction.description}
- Vendor: ${transaction.vendor || 'Unknown'}
- Amount: $${Math.abs(transaction.amount).toFixed(2)}
- Date: ${transaction.date}

Available expense categories:
${categoryList}

Based on the transaction description and vendor, which category best fits this expense?

Respond in JSON format only:
{
    "categoryId": "the ID of the best matching category",
    "categoryName": "the name of the category",
    "confidence": 0.0 to 1.0 (how confident you are),
    "reasoning": "brief explanation of why you chose this category"
}

If you cannot determine a category with at least 50% confidence, respond:
{
    "categoryId": null,
    "categoryName": null,
    "confidence": 0,
    "reasoning": "explanation of why it's unclear"
}`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }]
        });
        
        const content = response.content[0].text;
        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            return {
                ...result,
                source: 'ai'
            };
        }
    } catch (err) {
        console.error('AI categorization error:', err);
    }
    
    return null;
}

// Endpoint to categorize a single transaction
app.post('/api/quickbooks/categorize', async (req, res) => {
    try {
        if (!tokens.access_token) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        
        const { transaction } = req.body;
        
        // First check learned rules
        const ruleMatch = findMatchingRule(transaction.description, transaction.vendor);
        if (ruleMatch && ruleMatch.confidence >= 0.95) {
            return res.json({
                suggestion: ruleMatch,
                autoApproved: true
            });
        }
        
        // Fall back to AI
        if (!categoryCache.categories.length) {
            await fetchAndCacheCategories();
        }
        
        const aiResult = await aiCategorize(transaction, categoryCache.categories);
        
        res.json({
            suggestion: aiResult || ruleMatch,
            autoApproved: false
        });
    } catch (err) {
        console.error('Categorization error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Batch categorize multiple transactions
app.post('/api/quickbooks/categorize-batch', async (req, res) => {
    try {
        if (!tokens.access_token) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        
        const { transactions } = req.body;
        
        if (!categoryCache.categories.length) {
            await fetchAndCacheCategories();
        }
        
        const results = [];
        
        for (const txn of transactions) {
            // Check learned rules first
            const ruleMatch = findMatchingRule(txn.description, txn.vendor);
            
            if (ruleMatch && ruleMatch.confidence >= 0.95) {
                results.push({
                    transactionId: txn.id,
                    suggestion: ruleMatch,
                    autoApproved: true
                });
                continue;
            }
            
            // Try AI for unmatched transactions
            const aiResult = await aiCategorize(txn, categoryCache.categories);
            
            results.push({
                transactionId: txn.id,
                suggestion: aiResult || ruleMatch,
                autoApproved: false
            });
        }
        
        res.json({ results });
    } catch (err) {
        console.error('Batch categorization error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== UPDATE QUICKBOOKS TRANSACTION ==========

app.post('/api/quickbooks/update-transaction', async (req, res) => {
    try {
        if (!tokens.access_token) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        
        const { transactionId, transactionType, categoryId, categoryName } = req.body;
        
        console.log(`Updating ${transactionType} ${transactionId} to category ${categoryName}`);
        
        // Fetch the current transaction
        const query = `SELECT * FROM ${transactionType} WHERE Id = '${transactionId}'`;
        const result = await qbApiCall(`/query?query=${encodeURIComponent(query)}`);
        
        const transaction = result.QueryResponse?.[transactionType]?.[0];
        if (!transaction) {
            return res.status(404).json({ error: 'Transaction not found' });
        }
        
        // Update the line items with new category
        if (transaction.Line) {
            transaction.Line = transaction.Line.map(line => {
                if (line.DetailType === 'AccountBasedExpenseLineDetail') {
                    line.AccountBasedExpenseLineDetail.AccountRef = {
                        value: categoryId,
                        name: categoryName
                    };
                }
                return line;
            });
        }
        
        // Send update to QuickBooks
        const updateResult = await qbApiCall(
            `/${transactionType.toLowerCase()}?operation=update`,
            'POST',
            transaction
        );
        
        console.log(`✓ Updated ${transactionType} ${transactionId}`);
        
        res.json({ 
            success: true, 
            transaction: updateResult[transactionType]
        });
    } catch (err) {
        console.error('Update transaction error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== LEARN FROM APPROVAL ==========

app.post('/api/quickbooks/learn-rule', async (req, res) => {
    try {
        const { pattern, categoryId, categoryName, patternType = 'contains' } = req.body;
        
        // Check if rule already exists
        const existingIndex = learnedRules.findIndex(r => 
            r.pattern.toLowerCase() === pattern.toLowerCase() && r.patternType === patternType
        );
        
        if (existingIndex >= 0) {
            // Update existing rule
            learnedRules[existingIndex].categoryId = categoryId;
            learnedRules[existingIndex].categoryName = categoryName;
            learnedRules[existingIndex].timesUsed = (learnedRules[existingIndex].timesUsed || 1) + 1;
            learnedRules[existingIndex].updatedAt = new Date().toISOString();
        } else {
            // Add new rule
            learnedRules.push({
                id: `rule-${Date.now()}`,
                pattern: pattern,
                patternType: patternType,
                categoryId: categoryId,
                categoryName: categoryName,
                confidence: 1.0,
                timesUsed: 1,
                createdAt: new Date().toISOString()
            });
        }
        
        await saveRules();
        
        console.log(`✓ Learned rule: "${pattern}" → ${categoryName}`);
        
        res.json({ 
            success: true, 
            rulesCount: learnedRules.length 
        });
    } catch (err) {
        console.error('Learn rule error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get all learned rules
app.get('/api/quickbooks/rules', (req, res) => {
    res.json({ rules: learnedRules });
});

// Delete a rule
app.delete('/api/quickbooks/rules/:id', async (req, res) => {
    try {
        const { id } = req.params;
        learnedRules = learnedRules.filter(r => r.id !== id);
        await saveRules();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== MAIN DATA FETCH (with uncategorized detection) ==========

app.get('/api/quickbooks/data', async (req, res) => {
    try {
        if (!tokens.access_token) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const data = await fetchFinancialData();
        res.json(data);
    } catch (err) {
        console.error('Data fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/quickbooks/refresh', async (req, res) => {
    try {
        if (!tokens.access_token) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const data = await fetchFinancialData();
        res.json({ success: true, data });
    } catch (err) {
        console.error('Refresh error:', err);
        res.status(500).json({ error: err.message });
    }
});

async function fetchFinancialData() {
    const now = new Date();
    const twoYearsAgo = new Date(now.getFullYear() - 2, 0, 1);
    const endDate = now.toISOString().split('T')[0];
    const startDate = twoYearsAgo.toISOString().split('T')[0];

    console.log(`\n📊 Fetching QuickBooks data from ${startDate} to ${endDate}`);

    const plReport = await qbApiCall(
        `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&summarize_column_by=Month`
    );

    const dateFilter = `TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`;
    
    console.log('  → Fetching ALL Purchases (paginated)...');
    const purchaseRecords = await fetchAllRecords('Purchase', dateFilter);
    console.log(`     Found ${purchaseRecords.length} purchases`);

    console.log('  → Fetching ALL Bills (paginated)...');
    const billRecords = await fetchAllRecords('Bill', dateFilter);
    console.log(`     Found ${billRecords.length} bills`);

    console.log('  → Fetching ALL Journal Entries (paginated)...');
    const journalEntryRecords = await fetchAllRecords('JournalEntry', dateFilter);
    console.log(`     Found ${journalEntryRecords.length} journal entries`);

    console.log('  → Fetching ALL Vendor Credits (paginated)...');
    const vendorCreditRecords = await fetchAllRecords('VendorCredit', dateFilter);
    console.log(`     Found ${vendorCreditRecords.length} vendor credits`);

    console.log('  → Fetching ALL Sales Receipts (paginated)...');
    const salesReceiptRecords = await fetchAllRecords('SalesReceipt', dateFilter);
    console.log(`     Found ${salesReceiptRecords.length} sales receipts`);

    console.log('  → Fetching ALL Payments (paginated)...');
    const paymentRecords = await fetchAllRecords('Payment', dateFilter);
    console.log(`     Found ${paymentRecords.length} payments`);

    console.log('  → Fetching ALL Deposits (paginated)...');
    const depositRecords = await fetchAllRecords('Deposit', dateFilter);
    console.log(`     Found ${depositRecords.length} deposits`);

    console.log('  → Fetching ALL Refund Receipts (paginated)...');
    const refundReceiptRecords = await fetchAllRecords('RefundReceipt', dateFilter);
    console.log(`     Found ${refundReceiptRecords.length} refund receipts`);

    console.log('  → Fetching Accounts...');
    const accountRecords = await fetchAllRecords('Account');

    console.log('  → Fetching Vendors...');
    const vendorRecords = await fetchAllRecords('Vendor');

    // Build lookup maps
    const vendorMap = {};
    vendorRecords.forEach(v => {
        vendorMap[v.Id] = v.DisplayName || v.CompanyName || 'Unknown Vendor';
    });

    const accountMap = {};
    accountRecords.forEach(a => {
        accountMap[a.Id] = {
            name: a.Name,
            type: a.AccountType,
            subType: a.AccountSubType,
            fullName: a.FullyQualifiedName || a.Name
        };
    });

    // Track uncategorized transactions
    const uncategorizedKeywords = ['uncategorized', 'ask my accountant', 'undeposited'];
    const isUncategorized = (categoryName) => {
        if (!categoryName) return true;
        const lower = categoryName.toLowerCase();
        return uncategorizedKeywords.some(kw => lower.includes(kw));
    };

    const transactions = [];
    const needsReview = [];

    // Process Purchases
    purchaseRecords.forEach(p => {
        const vendorName = p.EntityRef?.name || vendorMap[p.EntityRef?.value] || '';
        const memo = p.PrivateNote || '';
        const paymentType = p.PaymentType || 'Unknown';
        
        const lineDetails = (p.Line || []).map(line => {
            if (line.AccountBasedExpenseLineDetail) {
                const acctId = line.AccountBasedExpenseLineDetail.AccountRef?.value;
                const acctName = line.AccountBasedExpenseLineDetail.AccountRef?.name || accountMap[acctId]?.name || '';
                return {
                    description: line.Description || acctName,
                    category: acctName,
                    categoryId: acctId,
                    amount: line.Amount
                };
            }
            if (line.ItemBasedExpenseLineDetail) {
                return {
                    description: line.Description || line.ItemBasedExpenseLineDetail.ItemRef?.name || '',
                    category: 'Items',
                    categoryId: null,
                    amount: line.Amount
                };
            }
            return null;
        }).filter(Boolean);

        if (lineDetails.length > 0) {
            lineDetails.forEach((line, idx) => {
                const txn = {
                    id: `purchase-${p.Id}-${idx}`,
                    qbId: p.Id,
                    qbType: 'Purchase',
                    date: p.TxnDate,
                    description: line.description || vendorName || memo || 'Purchase',
                    vendor: vendorName,
                    category: line.category || 'Uncategorized',
                    categoryId: line.categoryId,
                    amount: -Math.abs(line.amount),
                    type: 'expense',
                    paymentType: paymentType,
                    source: 'Purchase',
                    needsReview: isUncategorized(line.category)
                };
                
                transactions.push(txn);
                
                if (txn.needsReview) {
                    needsReview.push(txn);
                }
            });
        } else {
            const txn = {
                id: `purchase-${p.Id}`,
                qbId: p.Id,
                qbType: 'Purchase',
                date: p.TxnDate,
                description: vendorName || memo || 'Purchase',
                vendor: vendorName,
                category: 'Uncategorized',
                categoryId: null,
                amount: -Math.abs(p.TotalAmt),
                type: 'expense',
                paymentType: paymentType,
                source: 'Purchase',
                needsReview: true
            };
            
            transactions.push(txn);
            needsReview.push(txn);
        }
    });

    // Process Bills
    billRecords.forEach(b => {
        const vendorName = b.VendorRef?.name || vendorMap[b.VendorRef?.value] || '';
        const memo = b.PrivateNote || '';

        const lineDetails = (b.Line || []).map(line => {
            if (line.AccountBasedExpenseLineDetail) {
                const acctId = line.AccountBasedExpenseLineDetail.AccountRef?.value;
                const acctName = line.AccountBasedExpenseLineDetail.AccountRef?.name || '';
                return {
                    description: line.Description || acctName,
                    category: acctName,
                    categoryId: acctId,
                    amount: line.Amount
                };
            }
            return null;
        }).filter(Boolean);

        if (lineDetails.length > 0) {
            lineDetails.forEach((line, idx) => {
                const txn = {
                    id: `bill-${b.Id}-${idx}`,
                    qbId: b.Id,
                    qbType: 'Bill',
                    date: b.TxnDate,
                    description: line.description || vendorName || memo || 'Bill',
                    vendor: vendorName,
                    category: line.category || 'Uncategorized',
                    categoryId: line.categoryId,
                    amount: -Math.abs(line.amount),
                    type: 'expense',
                    source: 'Bill',
                    needsReview: isUncategorized(line.category)
                };
                
                transactions.push(txn);
                if (txn.needsReview) needsReview.push(txn);
            });
        }
    });

    // Process Journal Entries
    journalEntryRecords.forEach(je => {
        const memo = je.PrivateNote || je.DocNumber || '';
        
        (je.Line || []).forEach((line, idx) => {
            if (line.JournalEntryLineDetail) {
                const acctRef = line.JournalEntryLineDetail.AccountRef;
                const acctName = acctRef?.name || accountMap[acctRef?.value]?.name || 'Journal Entry';
                const acctType = accountMap[acctRef?.value]?.type || '';
                const postingType = line.JournalEntryLineDetail.PostingType;
                const amount = line.Amount || 0;
                
                if (amount === 0) return;
                
                let txnType = 'expense';
                let txnAmount = -Math.abs(amount);
                
                if (acctType === 'Expense' || acctType === 'Cost of Goods Sold' || acctType === 'Other Expense') {
                    if (postingType === 'Debit') {
                        txnType = 'expense';
                        txnAmount = -Math.abs(amount);
                    } else {
                        txnType = 'expense';
                        txnAmount = Math.abs(amount);
                    }
                } else if (acctType === 'Income' || acctType === 'Other Income') {
                    if (postingType === 'Credit') {
                        txnType = 'income';
                        txnAmount = Math.abs(amount);
                    } else {
                        txnType = 'income';
                        txnAmount = -Math.abs(amount);
                    }
                } else if (['Other Current Liability', 'Long Term Liability', 'Bank', 'Other Current Asset', 'Fixed Asset'].includes(acctType)) {
                    return;
                } else {
                    if (postingType === 'Debit') {
                        txnType = 'expense';
                        txnAmount = -Math.abs(amount);
                    } else {
                        return;
                    }
                }
                
                const isPayroll = 
                    acctName.toLowerCase().includes('payroll') ||
                    acctName.toLowerCase().includes('wage') ||
                    acctName.toLowerCase().includes('salary') ||
                    acctName.toLowerCase().includes('paychex') ||
                    memo.toLowerCase().includes('payroll') ||
                    memo.toLowerCase().includes('paychex');
                
                transactions.push({
                    id: `journal-${je.Id}-${idx}`,
                    qbId: je.Id,
                    qbType: 'JournalEntry',
                    date: je.TxnDate,
                    description: line.Description || memo || acctName,
                    vendor: '',
                    category: isPayroll ? 'Payroll Expenses' : acctName,
                    amount: txnAmount,
                    type: txnType,
                    source: 'JournalEntry',
                    isPayroll: isPayroll,
                    needsReview: false
                });
            }
        });
    });

    // Process Deposits
    depositRecords.forEach(d => {
        const lineDetails = (d.Line || []).map(line => {
            if (line.DepositLineDetail) {
                return {
                    description: line.DepositLineDetail.Entity?.name || line.Description || 'Deposit',
                    customer: line.DepositLineDetail.Entity?.name || '',
                    amount: line.Amount
                };
            }
            return null;
        }).filter(Boolean);

        if (lineDetails.length > 0) {
            lineDetails.forEach((line, idx) => {
                transactions.push({
                    id: `deposit-${d.Id}-${idx}`,
                    qbId: d.Id,
                    qbType: 'Deposit',
                    date: d.TxnDate,
                    description: line.description,
                    customer: line.customer,
                    category: 'Income',
                    amount: Math.abs(line.amount),
                    type: 'income',
                    source: 'Deposit',
                    needsReview: false
                });
            });
        } else {
            transactions.push({
                id: `deposit-${d.Id}`,
                qbId: d.Id,
                qbType: 'Deposit',
                date: d.TxnDate,
                description: d.PrivateNote || 'Bank Deposit',
                category: 'Income',
                amount: Math.abs(d.TotalAmt),
                type: 'income',
                source: 'Deposit',
                needsReview: false
            });
        }
    });

    // Process other income types...
    salesReceiptRecords.forEach(sr => {
        transactions.push({
            id: `salesreceipt-${sr.Id}`,
            qbId: sr.Id,
            qbType: 'SalesReceipt',
            date: sr.TxnDate,
            description: sr.CustomerRef?.name ? `Payment - ${sr.CustomerRef.name}` : 'Sales Receipt',
            customer: sr.CustomerRef?.name || '',
            category: 'Income',
            amount: Math.abs(sr.TotalAmt),
            type: 'income',
            source: 'SalesReceipt',
            needsReview: false
        });
    });

    paymentRecords.forEach(p => {
        transactions.push({
            id: `payment-${p.Id}`,
            qbId: p.Id,
            qbType: 'Payment',
            date: p.TxnDate,
            description: p.CustomerRef?.name ? `Payment - ${p.CustomerRef.name}` : 'Payment Received',
            customer: p.CustomerRef?.name || '',
            category: 'Income',
            amount: Math.abs(p.TotalAmt),
            type: 'income',
            source: 'Payment',
            needsReview: false
        });
    });

    refundReceiptRecords.forEach(rr => {
        transactions.push({
            id: `refund-${rr.Id}`,
            qbId: rr.Id,
            qbType: 'RefundReceipt',
            date: rr.TxnDate,
            description: `Refund to ${rr.CustomerRef?.name || 'Customer'}`,
            customer: rr.CustomerRef?.name || '',
            category: 'Refunds',
            amount: -Math.abs(rr.TotalAmt),
            type: 'expense',
            source: 'RefundReceipt',
            needsReview: false
        });
    });

    vendorCreditRecords.forEach(vc => {
        transactions.push({
            id: `vendorcredit-${vc.Id}`,
            qbId: vc.Id,
            qbType: 'VendorCredit',
            date: vc.TxnDate,
            description: `Credit from ${vc.VendorRef?.name || 'Vendor'}`,
            vendor: vc.VendorRef?.name || '',
            category: 'Vendor Credits',
            amount: Math.abs(vc.TotalAmt),
            type: 'expense',
            source: 'VendorCredit',
            needsReview: false
        });
    });

    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    needsReview.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Parse P&L for monthly summaries
    const monthlyData = parseMonthlyPL(plReport);

    // Calculate category totals
    const categoryTotals = {};
    transactions.filter(t => t.type === 'expense').forEach(t => {
        const cat = t.category || 'Uncategorized';
        categoryTotals[cat] = (categoryTotals[cat] || 0) + Math.abs(t.amount);
    });

    const categories = Object.entries(categoryTotals)
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount);

    const totalExpenses = transactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const totalIncome = transactions
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + t.amount, 0);

    const sourceCounts = {};
    transactions.forEach(t => {
        sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
    });

    console.log(`\n✓ Fetched ${transactions.length} total transactions`);
    console.log(`  ${needsReview.length} need review`);

    return {
        summary: {
            totalIncome,
            totalExpenses,
            netProfit: totalIncome - totalExpenses,
            transactionCount: transactions.length,
            needsReviewCount: needsReview.length
        },
        monthlyData,
        categories,
        transactions,
        needsReview,
        expenses: categoryTotals,
        timestamp: Date.now(),
        debug: {
            realm_id: tokens.realm_id,
            date_range: `${startDate} to ${endDate}`,
            purchase_count: purchaseRecords.length,
            bill_count: billRecords.length,
            journal_entry_count: journalEntryRecords.length,
            salesreceipt_count: salesReceiptRecords.length,
            payment_count: paymentRecords.length,
            deposit_count: depositRecords.length,
            refund_count: refundReceiptRecords.length,
            vendor_credit_count: vendorCreditRecords.length,
            needs_review_count: needsReview.length,
            sources: sourceCounts
        }
    };
}

function parseMonthlyPL(report) {
    const monthlyData = [];
    
    if (!report?.Rows?.Row) return monthlyData;

    const columns = report.Columns?.Column || [];
    const monthNames = columns.slice(1).map(c => {
        const parts = (c.ColTitle || '').split(' ');
        return parts[0] || '';
    });

    const findRow = (rows, label) => {
        for (const row of rows) {
            if (row.Summary?.ColData?.[0]?.value?.toLowerCase().includes(label.toLowerCase())) {
                return row.Summary;
            }
            if (row.Rows?.Row) {
                const found = findRow(row.Rows.Row, label);
                if (found) return found;
            }
        }
        return null;
    };

    const incomeRow = findRow(report.Rows.Row, 'Total Income');
    const expenseRow = findRow(report.Rows.Row, 'Total Expenses');

    monthNames.forEach((month, idx) => {
        if (!month) return;
        
        const revenue = parseFloat(incomeRow?.ColData?.[idx + 1]?.value) || 0;
        const expenses = parseFloat(expenseRow?.ColData?.[idx + 1]?.value) || 0;
        
        monthlyData.push({
            month,
            revenue,
            expenses,
            profit: revenue - expenses
        });
    });

    return monthlyData;
}

// ========== HEALTH CHECK ==========

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        connected: !!tokens.access_token,
        aiEnabled: !!anthropic,
        rulesLoaded: learnedRules.length,
        plaidEnabled: !!process.env.PLAID_CLIENT_ID
    });
});

app.get('/', (req, res) => {
    res.json({ 
        name: 'ASAP Financial Dashboard Backend v5 (AI + Plaid)',
        status: 'running',
        connected: !!tokens.access_token,
        aiEnabled: !!anthropic,
        plaidEnabled: !!process.env.PLAID_CLIENT_ID,
        learnedRules: learnedRules.length,
        endpoints: [
            'GET  /api/quickbooks/auth',
            'GET  /api/quickbooks/callback', 
            'GET  /api/quickbooks/status',
            'GET  /api/quickbooks/data',
            'GET  /api/quickbooks/categories',
            'GET  /api/quickbooks/rules',
            'POST /api/quickbooks/refresh',
            'POST /api/quickbooks/categorize',
            'POST /api/quickbooks/categorize-batch',
            'POST /api/quickbooks/update-transaction',
            'POST /api/quickbooks/learn-rule',
            'POST /api/quickbooks/disconnect',
            '--- PLAID ENDPOINTS ---',
            'POST /api/plaid/create-link-token',
            'POST /api/plaid/exchange-token',
            'GET  /api/plaid/accounts',
            'GET  /api/plaid/transactions',
            'POST /api/plaid/sync',
            'POST /api/plaid/disconnect'
        ]
    });
});

// ========== PLAID INTEGRATION ==========

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox'; // sandbox, development, production
const PLAID_BASE_URL = PLAID_ENV === 'production' 
    ? 'https://production.plaid.com'
    : PLAID_ENV === 'development'
        ? 'https://development.plaid.com'
        : 'https://sandbox.plaid.com';

// Store connected accounts - Supabase with file fallback
const PLAID_TOKENS_FILE = './plaid_tokens.json';
let plaidAccounts = [];

async function loadPlaidTokens() {
    // Try Supabase first
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('plaid_connections')
                .select('*')
                .order('connected_at', { ascending: false });
            
            if (error) {
                console.log('Supabase load error, falling back to file:', error.message);
            } else if (data && data.length > 0) {
                plaidAccounts = data.map(row => ({
                    id: row.id,
                    access_token: row.access_token,
                    item_id: row.item_id,
                    institution_id: row.institution_id,
                    institution_name: row.institution_name,
                    accounts: row.accounts || [],
                    excluded_accounts: row.excluded_accounts || [],
                    connected_at: row.connected_at,
                    last_synced: row.last_synced
                }));
                console.log(`✓ Loaded ${plaidAccounts.length} Plaid account(s) from Supabase`);
                return;
            }
        } catch (err) {
            console.log('Supabase load exception:', err.message);
        }
    }
    
    // Fallback to file
    try {
        if (fs.existsSync(PLAID_TOKENS_FILE)) {
            const data = fs.readFileSync(PLAID_TOKENS_FILE, 'utf8');
            plaidAccounts = JSON.parse(data);
            console.log(`✓ Loaded ${plaidAccounts.length} Plaid account(s) from file`);
            
            // If Supabase is available, migrate file tokens to Supabase
            if (supabase && plaidAccounts.length > 0) {
                console.log('Migrating tokens to Supabase...');
                await savePlaidTokens();
            }
        }
    } catch (err) {
        console.log('No saved Plaid tokens found');
    }
}

async function savePlaidTokens() {
    // Save to Supabase if available
    if (supabase) {
        try {
            for (const account of plaidAccounts) {
                const { error } = await supabase
                    .from('plaid_connections')
                    .upsert({
                        id: account.id,
                        access_token: account.access_token,
                        item_id: account.item_id,
                        institution_id: account.institution_id,
                        institution_name: account.institution_name,
                        accounts: account.accounts || [],
                        excluded_accounts: account.excluded_accounts || [],
                        connected_at: account.connected_at,
                        last_synced: account.last_synced,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'id' });
                
                if (error) {
                    console.error('Supabase save error for', account.institution_name, ':', error.message);
                }
            }
            console.log(`✓ Saved ${plaidAccounts.length} Plaid account(s) to Supabase`);
        } catch (err) {
            console.error('Supabase save exception:', err.message);
        }
    }
    
    // Always save to file as backup
    try {
        fs.writeFileSync(PLAID_TOKENS_FILE, JSON.stringify(plaidAccounts, null, 2));
    } catch (err) {
        console.error('Error saving Plaid tokens to file:', err);
    }
}

async function deletePlaidTokenFromSupabase(accountId) {
    if (supabase) {
        try {
            const { error } = await supabase
                .from('plaid_connections')
                .delete()
                .eq('id', accountId);
            
            if (error) {
                console.error('Supabase delete error:', error.message);
            } else {
                console.log(`✓ Deleted Plaid account ${accountId} from Supabase`);
            }
        } catch (err) {
            console.error('Supabase delete exception:', err.message);
        }
    }
}

// Create Link Token for Plaid Link
app.post('/api/plaid/create-link-token', async (req, res) => {
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
        return res.status(400).json({ 
            error: 'Plaid not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to environment variables.' 
        });
    }

    try {
        const response = await fetch(`${PLAID_BASE_URL}/link/token/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: PLAID_CLIENT_ID,
                secret: PLAID_SECRET,
                user: { client_user_id: 'asap-playbook-user' },
                client_name: 'ASAP Playbook',
                products: ['transactions'],
                country_codes: ['US'],
                language: 'en',
                // Allow user to select which accounts to share
                account_filters: {
                    depository: {
                        account_subtypes: ['checking', 'savings']
                    },
                    credit: {
                        account_subtypes: ['credit card']
                    }
                }
            })
        });

        const data = await response.json();
        
        if (data.link_token) {
            res.json({ link_token: data.link_token });
        } else {
            console.error('Plaid link token error:', data);
            res.status(400).json({ error: data.error_message || 'Failed to create link token' });
        }
    } catch (err) {
        console.error('Plaid create link token error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Exchange public token for access token
app.post('/api/plaid/exchange-token', async (req, res) => {
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
        return res.status(400).json({ error: 'Plaid not configured' });
    }

    const { public_token, institution } = req.body;

    try {
        // Exchange public token for access token
        const exchangeResponse = await fetch(`${PLAID_BASE_URL}/item/public_token/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: PLAID_CLIENT_ID,
                secret: PLAID_SECRET,
                public_token: public_token
            })
        });

        const exchangeData = await exchangeResponse.json();

        if (!exchangeData.access_token) {
            return res.status(400).json({ error: exchangeData.error_message || 'Failed to exchange token' });
        }

        // Get account info
        const accountsResponse = await fetch(`${PLAID_BASE_URL}/accounts/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: PLAID_CLIENT_ID,
                secret: PLAID_SECRET,
                access_token: exchangeData.access_token
            })
        });

        const accountsData = await accountsResponse.json();

        // Store the connection
        const newAccount = {
            id: `plaid-${Date.now()}`,
            access_token: exchangeData.access_token,
            item_id: exchangeData.item_id,
            institution_name: institution?.name || 'Unknown Bank',
            institution_id: institution?.institution_id,
            accounts: accountsData.accounts || [],
            connected_at: new Date().toISOString(),
            last_synced: null,
            cursor: null // For transaction sync
        };

        plaidAccounts.push(newAccount);
        await savePlaidTokens();

        console.log(`✓ Connected new bank: ${newAccount.institution_name}`);

        res.json({ 
            success: true, 
            institution: newAccount.institution_name,
            accounts: newAccount.accounts.map(a => ({
                id: a.account_id,
                name: a.name,
                type: a.type,
                subtype: a.subtype,
                mask: a.mask
            }))
        });
    } catch (err) {
        console.error('Plaid exchange token error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get connected accounts
app.get('/api/plaid/accounts', (req, res) => {
    const accounts = plaidAccounts.map(pa => ({
        id: pa.id,
        institution_name: pa.institution_name,
        connected_at: pa.connected_at,
        last_synced: pa.last_synced,
        accounts: pa.accounts.map(a => ({
            id: a.account_id,
            name: a.name,
            type: a.type,
            subtype: a.subtype,
            mask: a.mask,
            balance: a.balances?.current,
            excluded: pa.excluded_accounts?.includes(a.account_id) || false
        }))
    }));

    res.json({ 
        connected: plaidAccounts.length > 0,
        plaidEnabled: !!PLAID_CLIENT_ID,
        accounts 
    });
});

// Toggle individual account inclusion/exclusion
app.post('/api/plaid/toggle-account', async (req, res) => {
    const { institution_id, account_id, exclude } = req.body;
    
    const institution = plaidAccounts.find(pa => pa.id === institution_id);
    if (!institution) {
        return res.status(404).json({ error: 'Institution not found' });
    }
    
    // Initialize excluded_accounts array if not exists
    if (!institution.excluded_accounts) {
        institution.excluded_accounts = [];
    }
    
    if (exclude) {
        // Add to excluded list
        if (!institution.excluded_accounts.includes(account_id)) {
            institution.excluded_accounts.push(account_id);
        }
    } else {
        // Remove from excluded list
        institution.excluded_accounts = institution.excluded_accounts.filter(id => id !== account_id);
    }
    
    await savePlaidTokens();
    
    res.json({ 
        success: true, 
        account_id,
        excluded: exclude,
        message: exclude ? 'Account excluded from sync' : 'Account included in sync'
    });
});

// Sync transactions from all connected accounts
app.post('/api/plaid/sync', async (req, res) => {
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
        return res.status(400).json({ error: 'Plaid not configured' });
    }

    if (plaidAccounts.length === 0) {
        return res.status(400).json({ error: 'No bank accounts connected' });
    }

    try {
        const allTransactions = [];
        const errors = [];

        for (const account of plaidAccounts) {
            try {
                // Use transactions/sync for incremental updates
                const syncResponse = await fetch(`${PLAID_BASE_URL}/transactions/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: PLAID_CLIENT_ID,
                        secret: PLAID_SECRET,
                        access_token: account.access_token,
                        cursor: account.cursor || '',
                        count: 500
                    })
                });

                const syncData = await syncResponse.json();

                if (syncData.error_code) {
                    errors.push({ institution: account.institution_name, error: syncData.error_message });
                    continue;
                }

                // Get excluded accounts for this institution
                const excludedAccounts = account.excluded_accounts || [];

                // Process added transactions, filtering out excluded accounts
                const transactions = (syncData.added || [])
                    .filter(t => !excludedAccounts.includes(t.account_id))
                    .map(t => ({
                        id: t.transaction_id,
                        plaid_account_id: account.id,
                        account_id: t.account_id,
                        institution: account.institution_name,
                        date: t.date,
                        description: t.name,
                        merchant_name: t.merchant_name,
                        amount: t.amount, // Plaid: positive = debit, negative = credit
                        category: t.personal_finance_category?.primary || t.category?.[0] || 'Uncategorized',
                        category_detailed: t.personal_finance_category?.detailed || t.category?.join(' > '),
                        pending: t.pending,
                        type: t.amount > 0 ? 'expense' : 'income',
                        source: 'plaid'
                    }));

                allTransactions.push(...transactions);

                // Update cursor for next sync
                account.cursor = syncData.next_cursor;
                account.last_synced = new Date().toISOString();

                // Handle modified transactions (update existing)
                // Handle removed transactions (delete)
                // For now, we just track new ones

            } catch (err) {
                errors.push({ institution: account.institution_name, error: err.message });
            }
        }

        await savePlaidTokens();

        res.json({
            success: true,
            transactions_synced: allTransactions.length,
            transactions: allTransactions,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (err) {
        console.error('Plaid sync error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get transactions (uses stored data or fetches fresh)
app.get('/api/plaid/transactions', async (req, res) => {
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
        return res.status(400).json({ error: 'Plaid not configured' });
    }

    if (plaidAccounts.length === 0) {
        return res.json({ transactions: [], message: 'No bank accounts connected' });
    }

    const { start_date, end_date } = req.query;
    // Default to January 1, 2025 for full history
    const startDate = start_date || '2025-01-01';
    const endDate = end_date || new Date().toISOString().split('T')[0];

    try {
        const allTransactions = [];
        const errors = [];

        for (const account of plaidAccounts) {
            try {
                // Paginate through all transactions
                let offset = 0;
                let hasMore = true;
                const excludedAccounts = account.excluded_accounts || [];
                
                while (hasMore) {
                    const txnResponse = await fetch(`${PLAID_BASE_URL}/transactions/get`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            client_id: PLAID_CLIENT_ID,
                            secret: PLAID_SECRET,
                            access_token: account.access_token,
                            start_date: startDate,
                            end_date: endDate,
                            options: { count: 500, offset }
                        })
                    });

                    const txnData = await txnResponse.json();

                    if (txnData.error_code) {
                        errors.push({ institution: account.institution_name, error: txnData.error_message });
                        break;
                    }

                    const transactions = (txnData.transactions || [])
                        .filter(t => !excludedAccounts.includes(t.account_id))
                        .map(t => ({
                            id: t.transaction_id,
                            plaid_account_id: account.id,
                            account_id: t.account_id,
                            institution: account.institution_name,
                            date: t.date,
                            description: t.name,
                            merchant_name: t.merchant_name,
                            amount: t.amount,
                            category: t.personal_finance_category?.primary || t.category?.[0] || 'Uncategorized',
                            category_detailed: t.personal_finance_category?.detailed || t.category?.join(' > '),
                            pending: t.pending,
                            type: t.amount > 0 ? 'expense' : 'income',
                            source: 'plaid'
                        }));

                    allTransactions.push(...transactions);
                    
                    // Check if more pages exist
                    offset += txnData.transactions?.length || 0;
                    hasMore = offset < txnData.total_transactions;
                    
                    // Safety limit - max 5000 transactions per institution
                    if (offset >= 5000) break;
                }
                
                account.last_synced = new Date().toISOString();

            } catch (err) {
                errors.push({ institution: account.institution_name, error: err.message });
            }
        }

        await savePlaidTokens();

        // Sort by date descending
        allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json({
            transactions: allTransactions,
            count: allTransactions.length,
            date_range: { start: startDate, end: endDate },
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (err) {
        console.error('Plaid transactions error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Disconnect a bank account
app.post('/api/plaid/disconnect', async (req, res) => {
    const { account_id } = req.body;

    if (!account_id) {
        return res.status(400).json({ error: 'account_id required' });
    }

    const accountIndex = plaidAccounts.findIndex(a => a.id === account_id);
    
    if (accountIndex === -1) {
        return res.status(404).json({ error: 'Account not found' });
    }

    const account = plaidAccounts[accountIndex];

    // Optionally remove from Plaid (invalidate token)
    if (PLAID_CLIENT_ID && PLAID_SECRET && account.access_token) {
        try {
            await fetch(`${PLAID_BASE_URL}/item/remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: PLAID_CLIENT_ID,
                    secret: PLAID_SECRET,
                    access_token: account.access_token
                })
            });
        } catch (err) {
            console.log('Note: Could not remove item from Plaid:', err.message);
        }
    }

    const accountId = account.id;
    plaidAccounts.splice(accountIndex, 1);
    await savePlaidTokens();
    await deletePlaidTokenFromSupabase(accountId);

    console.log(`✓ Disconnected bank: ${account.institution_name}`);

    res.json({ success: true, message: `Disconnected ${account.institution_name}` });
});

// Refresh transactions to request more historical data
app.post('/api/plaid/refresh', async (req, res) => {
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
        return res.status(400).json({ error: 'Plaid not configured' });
    }

    if (plaidAccounts.length === 0) {
        return res.status(400).json({ error: 'No bank accounts connected' });
    }

    try {
        const results = [];
        
        for (const account of plaidAccounts) {
            try {
                // Request transaction refresh - this tells Plaid to fetch more historical data
                const refreshResponse = await fetch(`${PLAID_BASE_URL}/transactions/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: PLAID_CLIENT_ID,
                        secret: PLAID_SECRET,
                        access_token: account.access_token
                    })
                });

                const refreshData = await refreshResponse.json();

                if (refreshData.error_code) {
                    results.push({ 
                        institution: account.institution_name, 
                        success: false, 
                        error: refreshData.error_message 
                    });
                } else {
                    results.push({ 
                        institution: account.institution_name, 
                        success: true, 
                        message: 'Refresh requested - new data may take a few minutes' 
                    });
                }
            } catch (err) {
                results.push({ 
                    institution: account.institution_name, 
                    success: false, 
                    error: err.message 
                });
            }
        }

        res.json({ 
            success: true, 
            message: 'Refresh requested for all accounts. Historical data typically takes 24-48 hours to fully populate after initial connection.',
            results 
        });
    } catch (err) {
        console.error('Plaid refresh error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get Plaid connection status and data availability
app.get('/api/plaid/status', async (req, res) => {
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
        return res.json({ plaidEnabled: false });
    }

    const statusResults = [];

    for (const account of plaidAccounts) {
        try {
            // Get item info to check data availability
            const itemResponse = await fetch(`${PLAID_BASE_URL}/item/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: PLAID_CLIENT_ID,
                    secret: PLAID_SECRET,
                    access_token: account.access_token
                })
            });

            const itemData = await itemResponse.json();

            statusResults.push({
                institution: account.institution_name,
                connected_at: account.connected_at,
                last_synced: account.last_synced,
                item_id: itemData.item?.item_id,
                available_products: itemData.item?.available_products,
                consent_expiration: itemData.item?.consent_expiration_time,
                error: itemData.error_code ? itemData.error_message : null
            });
        } catch (err) {
            statusResults.push({
                institution: account.institution_name,
                error: err.message
            });
        }
    }

    res.json({
        plaidEnabled: true,
        accountCount: plaidAccounts.length,
        accounts: statusResults,
        note: 'Historical transaction data typically takes 24-48 hours to fully populate after initial connection.'
    });
});

// ========== START SERVER ==========

async function start() {
    // Initialize Supabase first (for persistent storage)
    initSupabase();
    
    await loadTokens();
    await loadRules();
    await loadPlaidTokens();
    
    // Initialize Anthropic AI
    initAnthropic();
    
    // Load categories if connected
    if (tokens.access_token) {
        try {
            await fetchAndCacheCategories();
        } catch (err) {
            console.log('Could not load categories on startup');
        }
    }

    app.listen(PORT, () => {
        console.log(`\n🚀 ASAP Financial Dashboard Backend v6.1`);
        console.log(`   Supabase Storage: ${supabase ? 'Enabled ✓' : 'Disabled (using file storage)'}`);
        console.log(`   AI Categorization: ${anthropic ? 'Enabled' : 'Disabled (add ANTHROPIC_API_KEY)'}`);
        console.log(`   Plaid Integration: ${PLAID_CLIENT_ID ? 'Enabled' : 'Disabled (add PLAID_CLIENT_ID, PLAID_SECRET)'}`);
        console.log(`   Server running on port ${PORT}`);
        console.log(`   QB Environment: ${QB_ENVIRONMENT}`);
        console.log(`   QB Connected: ${!!tokens.access_token}`);
        console.log(`   Plaid Accounts: ${plaidAccounts.length}`);
        console.log(`   Learned Rules: ${learnedRules.length}`);
    });
}

start();
