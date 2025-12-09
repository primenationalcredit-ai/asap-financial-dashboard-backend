/**
 * ASAP Credit Repair - QuickBooks Financial Dashboard Backend
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Read environment variables directly
const QB_CLIENT_ID = process.env.QB_CLIENT_ID || 'ABpPICXjHYvW5m9HnZUAuDjYcXOOpsZitHPN3kLeX1l7Im75a2';
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET || 'aLfq67TCVTahuI2leAoblXkiWmgm3L0kzH120X6e';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://asap-financial-dashboard-backend-production-b444.up.railway.app/api/quickbooks/callback';
```

6. Commit the changes

Wait for Railway to redeploy, then test:
```
https://asap-financial-dashboard-backend-production-b444.up.railway.app/api/quickbooks/auth

// Log startup config (without secrets)
console.log('Starting server with config:');
console.log('- QB_CLIENT_ID:', QB_CLIENT_ID ? QB_CLIENT_ID.substring(0, 10) + '...' : 'NOT SET');
console.log('- QB_CLIENT_SECRET:', QB_CLIENT_SECRET ? '***SET***' : 'NOT SET');
console.log('- REDIRECT_URI:', REDIRECT_URI || 'NOT SET');
console.log('- PORT:', PORT);

// QuickBooks API endpoints
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com/v3/company';

// Token storage
const TOKEN_FILE = path.join('/tmp', 'tokens.json');
const DATA_FILE = path.join('/tmp', 'financial_data.json');

// Middleware
app.use(cors());
app.use(express.json());

// Token management
let tokens = {
    access_token: null,
    refresh_token: null,
    expires_at: null,
    realm_id: null
};

async function loadTokens() {
    try {
        const data = await fs.readFile(TOKEN_FILE, 'utf8');
        tokens = JSON.parse(data);
        console.log('✓ Loaded saved tokens');
    } catch (err) {
        console.log('No saved tokens found');
    }
}

async function saveTokens() {
    try {
        await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
        console.log('✓ Tokens saved');
    } catch (err) {
        console.error('Error saving tokens:', err);
    }
}

async function refreshAccessToken() {
    if (!tokens.refresh_token) {
        throw new Error('No refresh token available');
    }

    const credentials = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');

    const response = await fetch(TOKEN_URL, {
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

async function getAccessToken() {
    if (!tokens.access_token) {
        throw new Error('Not authenticated with QuickBooks');
    }

    if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) {
        await refreshAccessToken();
    }

    return tokens.access_token;
}

async function qbRequest(endpoint, method = 'GET', body = null) {
    const accessToken = await getAccessToken();
    const url = `${API_BASE}/${tokens.realm_id}${endpoint}`;

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

async function qbQuery(query) {
    const encoded = encodeURIComponent(query);
    return qbRequest(`/query?query=${encoded}`);
}

// ========== API ROUTES ==========

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'ASAP Financial Dashboard Backend' });
});

// Get OAuth URL
app.get('/api/quickbooks/auth', (req, res) => {
    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('client_id', QB_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('state', 'asap_financial_dashboard');

    res.json({ authUrl: authUrl.toString() });
});

// OAuth callback
app.get('/api/quickbooks/callback', async (req, res) => {
    const { code, realmId, state } = req.query;

    console.log('OAuth callback received:', { code: code ? 'yes' : 'no', realmId, state });

    if (!code) {
        return res.status(400).json({ error: 'Missing authorization code' });
    }

    try {
        const credentials = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');

        console.log('Exchanging code for tokens...');
        console.log('Using REDIRECT_URI:', REDIRECT_URI);

        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Authorization': `Basic ${credentials}`
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI
            })
        });

        const responseText = await response.text();
        console.log('Token response status:', response.status);

        if (!response.ok) {
            console.error('Token exchange failed:', responseText);
            throw new Error(`Token exchange failed: ${responseText}`);
        }

        const data = JSON.parse(responseText);

        tokens = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + (data.expires_in * 1000),
            realm_id: realmId
        };

        await saveTokens();
        console.log('✓ Successfully authenticated with QuickBooks');

        res.json({ success: true, message: 'Connected to QuickBooks' });
    } catch (err) {
        console.error('OAuth callback error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Check status
app.get('/api/quickbooks/status', (req, res) => {
    res.json({
        connected: !!tokens.access_token,
        company_id: tokens.realm_id
    });
});

// Disconnect
app.post('/api/quickbooks/disconnect', async (req, res) => {
    tokens = { access_token: null, refresh_token: null, expires_at: null, realm_id: null };
    await saveTokens();
    res.json({ success: true });
});

// Get financial data
app.get('/api/quickbooks/data', async (req, res) => {
    try {
        try {
            const cached = await fs.readFile(DATA_FILE, 'utf8');
            const data = JSON.parse(cached);
            if (data.timestamp && Date.now() - data.timestamp < 3600000) {
                return res.json(data);
            }
        } catch (err) { }

        const data = await fetchFinancialData();
        res.json(data);
    } catch (err) {
        console.error('Data fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Force refresh
app.post('/api/quickbooks/refresh', async (req, res) => {
    try {
        const data = await fetchFinancialData();
        res.json(data);
    } catch (err) {
        console.error('Refresh error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== DATA FETCHING ==========

async function fetchFinancialData() {
    console.log('Fetching financial data from QuickBooks...');

    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const startOfYear = `${currentYear}-01-01`;
    const endDate = currentDate.toISOString().split('T')[0];

    const months = [];
    for (let i = 5; i >= 0; i--) {
        const date = new Date(currentYear, currentDate.getMonth() - i, 1);
        months.push({
            start: date.toISOString().split('T')[0],
            end: new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0],
            name: date.toLocaleString('default', { month: 'short' })
        });
    }

    const plReport = await qbRequest(`/reports/ProfitAndLoss?start_date=${startOfYear}&end_date=${endDate}&summarize_column_by=Month`);
    const purchases = await qbQuery(`SELECT * FROM Purchase WHERE TxnDate >= '${months[0].start}' ORDER BY TxnDate DESC MAXRESULTS 100`);
    const salesReceipts = await qbQuery(`SELECT * FROM SalesReceipt WHERE TxnDate >= '${months[0].start}' ORDER BY TxnDate DESC MAXRESULTS 100`);
    const invoices = await qbQuery(`SELECT * FROM Invoice WHERE TxnDate >= '${months[0].start}' ORDER BY TxnDate DESC MAXRESULTS 100`);
    const accounts = await qbQuery('SELECT * FROM Account');

    const processedData = processQuickBooksData(plReport, purchases, salesReceipts, invoices, accounts, months);
    processedData.timestamp = Date.now();
    
    await fs.writeFile(DATA_FILE, JSON.stringify(processedData, null, 2));
    console.log('✓ Financial data cached');

    return processedData;
}

function processQuickBooksData(plReport, purchases, salesReceipts, invoices, accounts, months) {
    const summary = parsePLReport(plReport);

    const monthlyData = months.map(m => {
        const monthData = extractMonthData(plReport, m.name);
        return {
            month: m.name,
            revenue: monthData.revenue || 0,
            expenses: monthData.expenses || 0,
            profit: (monthData.revenue || 0) - (monthData.expenses || 0)
        };
    });

    const categories = categorizeExpenses(purchases?.QueryResponse?.Purchase || [], accounts?.QueryResponse?.Account || []);

    const transactions = formatTransactions(
        purchases?.QueryResponse?.Purchase || [],
        salesReceipts?.QueryResponse?.SalesReceipt || [],
        invoices?.QueryResponse?.Invoice || [],
        accounts?.QueryResponse?.Account || []
    );

    const currentMonth = monthlyData[monthlyData.length - 1];
    const prevMonth = monthlyData[monthlyData.length - 2] || currentMonth;

    const revenueChange = prevMonth.revenue ? ((currentMonth.revenue - prevMonth.revenue) / prevMonth.revenue) * 100 : 0;
    const expensesChange = prevMonth.expenses ? ((currentMonth.expenses - prevMonth.expenses) / prevMonth.expenses) * 100 : 0;
    const profitChange = prevMonth.profit ? ((currentMonth.profit - prevMonth.profit) / prevMonth.profit) * 100 : 0;

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
        transactions: transactions.slice(0, 20)
    };
}

function parsePLReport(plReport) {
    const rows = plReport?.Rows?.Row || [];
    let totalIncome = 0, totalExpenses = 0, netIncome = 0;

    rows.forEach(row => {
        if (row.Summary?.ColData) {
            const label = row.Summary.ColData[0]?.value || '';
            const value = parseFloat(row.Summary.ColData[1]?.value) || 0;
            if (label.includes('Total Income') || label.includes('Gross Profit')) totalIncome = value;
            else if (label.includes('Total Expenses')) totalExpenses = Math.abs(value);
            else if (label.includes('Net Income') || label.includes('Net Operating Income')) netIncome = value;
        }
    });

    return { totalIncome, totalExpenses, netIncome };
}

function extractMonthData(plReport, monthName) {
    const columns = plReport?.Columns?.Column || [];
    const monthIndex = columns.findIndex(c => c.ColTitle && c.ColTitle.includes(monthName));
    if (monthIndex === -1) return { revenue: 0, expenses: 0 };

    let revenue = 0, expenses = 0;
    const rows = plReport?.Rows?.Row || [];
    rows.forEach(row => {
        if (row.Summary?.ColData && row.Summary.ColData[monthIndex]) {
            const label = row.Summary.ColData[0]?.value || '';
            const value = parseFloat(row.Summary.ColData[monthIndex]?.value) || 0;
            if (label.includes('Total Income')) revenue = value;
            else if (label.includes('Total Expenses')) expenses = Math.abs(value);
        }
    });

    return { revenue, expenses };
}

function categorizeExpenses(purchases, accounts) {
    const accountMap = {};
    accounts.forEach(acc => { accountMap[acc.Id] = acc; });

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
        if (categoryMapping.payroll.some(k => searchText.includes(k.toLowerCase()))) { categories['Payroll'].amount += amount; categorized = true; }
        else if (categoryMapping.software.some(k => searchText.includes(k.toLowerCase()))) { categories['Software/Tools'].amount += amount; categorized = true; }
        else if (categoryMapping.marketing.some(k => searchText.includes(k.toLowerCase()))) { categories['Marketing'].amount += amount; categorized = true; }
        else if (categoryMapping.merchant.some(k => searchText.includes(k.toLowerCase()))) { categories['Merchant Fees'].amount += amount; categorized = true; }
        if (!categorized) categories['Uncategorized'].amount += amount;
    });

    return Object.entries(categories)
        .map(([name, data]) => ({ name, amount: Math.round(data.amount * 100) / 100, color: data.color }))
        .sort((a, b) => b.amount - a.amount);
}

function formatTransactions(purchases, salesReceipts, invoices, accounts) {
    const accountMap = {};
    accounts.forEach(acc => { accountMap[acc.Id] = acc.Name; });

    const transactions = [];

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

    invoices.forEach(i => {
        const balance = parseFloat(i.Balance) || 0;
        const total = parseFloat(i.TotalAmt) || 0;
        if (balance < total) {
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

    return transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Start server
async function start() {
    await loadTokens();

    app.listen(PORT, () => {
        console.log(`\n🚀 ASAP Financial Dashboard Backend`);
        console.log(`   Server running on port ${PORT}`);
        console.log(`\n   Environment Variables:`);
        console.log(`   - QB_CLIENT_ID: ${QB_CLIENT_ID ? 'SET' : 'NOT SET'}`);
        console.log(`   - QB_CLIENT_SECRET: ${QB_CLIENT_SECRET ? 'SET' : 'NOT SET'}`);
        console.log(`   - REDIRECT_URI: ${REDIRECT_URI || 'NOT SET'}`);
    });
}

start();
