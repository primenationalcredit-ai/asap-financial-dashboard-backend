/**
 * ASAP Credit Repair - QuickBooks Financial Dashboard Backend
 * 
 * This server handles:
 * 1. QuickBooks OAuth 2.0 authentication
 * 2. Data fetching from QuickBooks API
 * 3. Scheduled syncing (every 4 hours to respect API limits)
 * 4. Data transformation for the dashboard
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuration - Set these in environment variables
const CONFIG = {
    QUICKBOOKS_CLIENT_ID: process.env.QB_CLIENT_ID || '',
    QUICKBOOKS_CLIENT_SECRET: process.env.QB_CLIENT_SECRET || '',
    REDIRECT_URI: process.env.REDIRECT_URI || 'http://localhost:3001/api/quickbooks/callback',
    COMPANY_ID: process.env.QB_COMPANY_ID || '',
    // QuickBooks API endpoints
    AUTH_URL: 'https://appcenter.intuit.com/connect/oauth2',
    TOKEN_URL: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    API_BASE: 'https://quickbooks.api.intuit.com/v3/company',
    // File paths for token storage (use database in production)
    TOKEN_FILE: path.join(__dirname, 'tokens.json'),
    DATA_FILE: path.join(__dirname, 'financial_data.json')
};

// Middleware
app.use(cors());
app.use(express.json());

// Token management
let tokens = {
    access_token: null,
    refresh_token: null,
    expires_at: null,
    realm_id: null // QuickBooks Company ID
};

// Load saved tokens on startup
async function loadTokens() {
    try {
        const data = await fs.readFile(CONFIG.TOKEN_FILE, 'utf8');
        tokens = JSON.parse(data);
        console.log('✓ Loaded saved tokens');
    } catch (err) {
        console.log('No saved tokens found');
    }
}

// Save tokens to file
async function saveTokens() {
    try {
        await fs.writeFile(CONFIG.TOKEN_FILE, JSON.stringify(tokens, null, 2));
        console.log('✓ Tokens saved');
    } catch (err) {
        console.error('Error saving tokens:', err);
    }
}

// Refresh access token if expired
async function refreshAccessToken() {
    if (!tokens.refresh_token) {
        throw new Error('No refresh token available');
    }

    const credentials = Buffer.from(
        `${CONFIG.QUICKBOOKS_CLIENT_ID}:${CONFIG.QUICKBOOKS_CLIENT_SECRET}`
    ).toString('base64');

    const response = await fetch(CONFIG.TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Authorization': `Basic ${credentials}`
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();
    tokens.access_token = data.access_token;
    tokens.refresh_token = data.refresh_token;
    tokens.expires_at = Date.now() + (data.expires_in * 1000);
    
    await saveTokens();
    console.log('✓ Access token refreshed');
}

// Get valid access token
async function getAccessToken() {
    if (!tokens.access_token) {
        throw new Error('Not authenticated with QuickBooks');
    }

    // Refresh if expired (with 5 min buffer)
    if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) {
        await refreshAccessToken();
    }

    return tokens.access_token;
}

// Make authenticated QuickBooks API request
async function qbRequest(endpoint, method = 'GET', body = null) {
    const accessToken = await getAccessToken();
    const url = `${CONFIG.API_BASE}/${tokens.realm_id}${endpoint}`;

    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`QuickBooks API error: ${response.status} - ${error}`);
    }

    return response.json();
}

// Query QuickBooks data
async function qbQuery(query) {
    const encoded = encodeURIComponent(query);
    return qbRequest(`/query?query=${encoded}`);
}

// ========== API ROUTES ==========

// Step 1: Initiate OAuth flow
app.get('/api/quickbooks/auth', (req, res) => {
    const authUrl = new URL(CONFIG.AUTH_URL);
    authUrl.searchParams.set('client_id', CONFIG.QUICKBOOKS_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
    authUrl.searchParams.set('redirect_uri', CONFIG.REDIRECT_URI);
    authUrl.searchParams.set('state', 'asap_financial_dashboard');

    res.json({ authUrl: authUrl.toString() });
});

// Step 2: OAuth callback - exchange code for tokens
app.get('/api/quickbooks/callback', async (req, res) => {
    const { code, realmId, state } = req.query;

    if (!code || !realmId) {
        return res.status(400).json({ error: 'Missing code or realmId' });
    }

    try {
        const credentials = Buffer.from(
            `${CONFIG.QUICKBOOKS_CLIENT_ID}:${CONFIG.QUICKBOOKS_CLIENT_SECRET}`
        ).toString('base64');

        const response = await fetch(CONFIG.TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Authorization': `Basic ${credentials}`
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: CONFIG.REDIRECT_URI
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token exchange failed: ${error}`);
        }

        const data = await response.json();

        tokens = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + (data.expires_in * 1000),
            realm_id: realmId
        };

        await saveTokens();

        // Redirect back to dashboard
        res.redirect('/?connected=true');
    } catch (err) {
        console.error('OAuth callback error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Check authentication status
app.get('/api/quickbooks/status', (req, res) => {
    res.json({
        connected: !!tokens.access_token,
        company_id: tokens.realm_id
    });
});

// Disconnect from QuickBooks
app.post('/api/quickbooks/disconnect', async (req, res) => {
    tokens = {
        access_token: null,
        refresh_token: null,
        expires_at: null,
        realm_id: null
    };
    await saveTokens();
    res.json({ success: true });
});

// Get financial dashboard data
app.get('/api/quickbooks/data', async (req, res) => {
    try {
        // Try to return cached data first
        try {
            const cached = await fs.readFile(CONFIG.DATA_FILE, 'utf8');
            const data = JSON.parse(cached);
            // Return cached if less than 1 hour old
            if (data.timestamp && Date.now() - data.timestamp < 3600000) {
                return res.json(data);
            }
        } catch (err) {
            // No cached data, fetch fresh
        }

        // Fetch fresh data from QuickBooks
        const data = await fetchFinancialData();
        res.json(data);
    } catch (err) {
        console.error('Data fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Force refresh data
app.post('/api/quickbooks/refresh', async (req, res) => {
    try {
        const data = await fetchFinancialData();
        res.json(data);
    } catch (err) {
        console.error('Refresh error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== DATA FETCHING FUNCTIONS ==========

async function fetchFinancialData() {
    console.log('Fetching financial data from QuickBooks...');

    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const startOfYear = `${currentYear}-01-01`;
    const endDate = currentDate.toISOString().split('T')[0];

    // Get last 6 months for monthly breakdown
    const months = [];
    for (let i = 5; i >= 0; i--) {
        const date = new Date(currentYear, currentDate.getMonth() - i, 1);
        months.push({
            start: date.toISOString().split('T')[0],
            end: new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0],
            name: date.toLocaleString('default', { month: 'short' })
        });
    }

    // Fetch Profit and Loss report
    const plReport = await qbRequest(
        `/reports/ProfitAndLoss?start_date=${startOfYear}&end_date=${endDate}&summarize_column_by=Month`
    );

    // Fetch recent transactions (purchases/expenses)
    const purchases = await qbQuery(
        `SELECT * FROM Purchase WHERE TxnDate >= '${months[0].start}' ORDER BY TxnDate DESC MAXRESULTS 100`
    );

    // Fetch recent sales receipts and invoices (income)
    const salesReceipts = await qbQuery(
        `SELECT * FROM SalesReceipt WHERE TxnDate >= '${months[0].start}' ORDER BY TxnDate DESC MAXRESULTS 100`
    );

    const invoices = await qbQuery(
        `SELECT * FROM Invoice WHERE TxnDate >= '${months[0].start}' ORDER BY TxnDate DESC MAXRESULTS 100`
    );

    // Fetch accounts for categorization
    const accounts = await qbQuery('SELECT * FROM Account');

    // Process and transform the data
    const processedData = processQuickBooksData(plReport, purchases, salesReceipts, invoices, accounts, months);

    // Cache the data
    processedData.timestamp = Date.now();
    await fs.writeFile(CONFIG.DATA_FILE, JSON.stringify(processedData, null, 2));
    console.log('✓ Financial data cached');

    return processedData;
}

function processQuickBooksData(plReport, purchases, salesReceipts, invoices, accounts, months) {
    // Parse P&L report for summary data
    const summary = parsePLReport(plReport);

    // Process monthly data
    const monthlyData = months.map(m => {
        const monthData = extractMonthData(plReport, m.name);
        return {
            month: m.name,
            revenue: monthData.revenue || 0,
            expenses: monthData.expenses || 0,
            profit: (monthData.revenue || 0) - (monthData.expenses || 0)
        };
    });

    // Categorize expenses
    const categories = categorizeExpenses(purchases?.QueryResponse?.Purchase || [], accounts?.QueryResponse?.Account || []);

    // Combine and sort transactions
    const transactions = formatTransactions(
        purchases?.QueryResponse?.Purchase || [],
        salesReceipts?.QueryResponse?.SalesReceipt || [],
        invoices?.QueryResponse?.Invoice || [],
        accounts?.QueryResponse?.Account || []
    );

    // Calculate changes from previous month
    const currentMonth = monthlyData[monthlyData.length - 1];
    const prevMonth = monthlyData[monthlyData.length - 2] || currentMonth;

    const revenueChange = prevMonth.revenue ? 
        ((currentMonth.revenue - prevMonth.revenue) / prevMonth.revenue) * 100 : 0;
    const expensesChange = prevMonth.expenses ? 
        ((currentMonth.expenses - prevMonth.expenses) / prevMonth.expenses) * 100 : 0;
    const profitChange = prevMonth.profit ? 
        ((currentMonth.profit - prevMonth.profit) / prevMonth.profit) * 100 : 0;

    return {
        summary: {
            totalRevenue: summary.totalIncome || monthlyData.reduce((sum, m) => sum + m.revenue, 0),
            totalExpenses: summary.totalExpenses || monthlyData.reduce((sum, m) => sum + m.expenses, 0),
            netProfit: summary.netIncome || monthlyData.reduce((sum, m) => sum + m.profit, 0),
            revenueChange: Math.round(revenueChange * 10) / 10,
            expensesChange: Math.round(expensesChange * 10) / 10,
            profitChange: Math.round(profitChange * 10) / 10
        },
        monthlyData,
        categories,
        transactions: transactions.slice(0, 20) // Return top 20 most recent
    };
}

function parsePLReport(plReport) {
    // QuickBooks P&L report structure varies - this handles common format
    const rows = plReport?.Rows?.Row || [];
    let totalIncome = 0;
    let totalExpenses = 0;
    let netIncome = 0;

    rows.forEach(row => {
        if (row.Summary?.ColData) {
            const label = row.Summary.ColData[0]?.value || '';
            const value = parseFloat(row.Summary.ColData[1]?.value) || 0;

            if (label.includes('Total Income') || label.includes('Gross Profit')) {
                totalIncome = value;
            } else if (label.includes('Total Expenses')) {
                totalExpenses = Math.abs(value);
            } else if (label.includes('Net Income') || label.includes('Net Operating Income')) {
                netIncome = value;
            }
        }
    });

    return { totalIncome, totalExpenses, netIncome };
}

function extractMonthData(plReport, monthName) {
    // Extract data for a specific month from P&L report columns
    const columns = plReport?.Columns?.Column || [];
    const monthIndex = columns.findIndex(c => 
        c.ColTitle && c.ColTitle.includes(monthName)
    );

    if (monthIndex === -1) return { revenue: 0, expenses: 0 };

    let revenue = 0;
    let expenses = 0;

    const rows = plReport?.Rows?.Row || [];
    rows.forEach(row => {
        if (row.Summary?.ColData && row.Summary.ColData[monthIndex]) {
            const label = row.Summary.ColData[0]?.value || '';
            const value = parseFloat(row.Summary.ColData[monthIndex]?.value) || 0;

            if (label.includes('Total Income')) {
                revenue = value;
            } else if (label.includes('Total Expenses')) {
                expenses = Math.abs(value);
            }
        }
    });

    return { revenue, expenses };
}

function categorizeExpenses(purchases, accounts) {
    // Create account lookup
    const accountMap = {};
    accounts.forEach(acc => {
        accountMap[acc.Id] = acc;
    });

    // Category mapping for common expense types
    const categoryMapping = {
        'payroll': ['Payroll', 'Salary', 'Wages', 'Commission'],
        'software': ['Software', 'Subscription', 'SaaS', 'Technology'],
        'marketing': ['Marketing', 'Advertising', 'Ads', 'Promotion'],
        'merchant': ['Merchant', 'Processing', 'Stripe', 'PayPal', 'Payment']
    };

    const categories = {
        'Payroll': { amount: 0, color: '#ef4444' },
        'Software/Tools': { amount: 0, color: '#f59e0b' },
        'Marketing': { amount: 0, color: '#3b82f6' },
        'Merchant Fees': { amount: 0, color: '#8b5cf6' },
        'Uncategorized': { amount: 0, color: '#64748b' }
    };

    purchases.forEach(purchase => {
        const amount = Math.abs(parseFloat(purchase.TotalAmt) || 0);
        const account = accountMap[purchase.AccountRef?.value];
        const accountName = account?.Name || '';
        const memo = purchase.PrivateNote || '';
        const searchText = `${accountName} ${memo}`.toLowerCase();

        let categorized = false;

        if (categoryMapping.payroll.some(k => searchText.includes(k.toLowerCase()))) {
            categories['Payroll'].amount += amount;
            categorized = true;
        } else if (categoryMapping.software.some(k => searchText.includes(k.toLowerCase()))) {
            categories['Software/Tools'].amount += amount;
            categorized = true;
        } else if (categoryMapping.marketing.some(k => searchText.includes(k.toLowerCase()))) {
            categories['Marketing'].amount += amount;
            categorized = true;
        } else if (categoryMapping.merchant.some(k => searchText.includes(k.toLowerCase()))) {
            categories['Merchant Fees'].amount += amount;
            categorized = true;
        }

        if (!categorized) {
            categories['Uncategorized'].amount += amount;
        }
    });

    // Convert to array and sort by amount
    return Object.entries(categories)
        .map(([name, data]) => ({
            name,
            amount: Math.round(data.amount * 100) / 100,
            color: data.color
        }))
        .sort((a, b) => b.amount - a.amount);
}

function formatTransactions(purchases, salesReceipts, invoices, accounts) {
    const accountMap = {};
    accounts.forEach(acc => {
        accountMap[acc.Id] = acc.Name;
    });

    const transactions = [];

    // Process purchases (expenses)
    purchases.forEach(p => {
        transactions.push({
            id: p.Id,
            date: p.TxnDate,
            description: p.PrivateNote || accountMap[p.AccountRef?.value] || 'Expense',
            category: accountMap[p.AccountRef?.value] || 'Expense',
            amount: -Math.abs(parseFloat(p.TotalAmt) || 0),
            type: 'expense'
        });
    });

    // Process sales receipts (income)
    salesReceipts.forEach(s => {
        transactions.push({
            id: s.Id,
            date: s.TxnDate,
            description: s.CustomerRef?.name ? `Payment - ${s.CustomerRef.name}` : 'Sales Receipt',
            category: 'Income',
            amount: parseFloat(s.TotalAmt) || 0,
            type: 'income'
        });
    });

    // Process invoices (income)
    invoices.forEach(i => {
        const balance = parseFloat(i.Balance) || 0;
        const total = parseFloat(i.TotalAmt) || 0;
        if (balance < total) { // Partially or fully paid
            transactions.push({
                id: i.Id,
                date: i.TxnDate,
                description: i.CustomerRef?.name ? `Invoice Payment - ${i.CustomerRef.name}` : 'Invoice',
                category: 'Income',
                amount: total - balance,
                type: 'income'
            });
        }
    });

    // Sort by date descending
    return transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// ========== SCHEDULED SYNC ==========

// Sync every 4 hours (QuickBooks rate limit friendly)
const SYNC_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

async function scheduledSync() {
    if (!tokens.access_token) {
        console.log('Skipping sync - not authenticated');
        return;
    }

    try {
        console.log('Running scheduled data sync...');
        await fetchFinancialData();
        console.log('✓ Scheduled sync complete');
    } catch (err) {
        console.error('Scheduled sync error:', err.message);
    }
}

// Start the server
async function start() {
    await loadTokens();

    app.listen(PORT, () => {
        console.log(`\n🚀 ASAP Financial Dashboard Backend`);
        console.log(`   Server running on http://localhost:${PORT}`);
        console.log(`   API Base: http://localhost:${PORT}/api/quickbooks`);
        console.log(`\n   Endpoints:`);
        console.log(`   - GET  /api/quickbooks/auth     - Get OAuth URL`);
        console.log(`   - GET  /api/quickbooks/callback - OAuth callback`);
        console.log(`   - GET  /api/quickbooks/status   - Check connection`);
        console.log(`   - GET  /api/quickbooks/data     - Get financial data`);
        console.log(`   - POST /api/quickbooks/refresh  - Force refresh data`);
        console.log(`   - POST /api/quickbooks/disconnect - Disconnect\n`);
    });

    // Start scheduled syncing
    setInterval(scheduledSync, SYNC_INTERVAL);
}

start();
