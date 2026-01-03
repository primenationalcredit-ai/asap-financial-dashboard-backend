const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// QuickBooks OAuth Configuration
const QB_CLIENT_ID = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const QB_REDIRECT_URI = process.env.QB_REDIRECT_URI || 'https://asap-financial-dashboard-backend-production-b444.up.railway.app/api/quickbooks/callback';
const QB_ENVIRONMENT = process.env.QB_ENVIRONMENT || 'production';

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

// Try to load tokens from file (for persistence across restarts)
const TOKEN_FILE = './qb_tokens.json';
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
            
            // Redirect to frontend
            const frontendUrl = process.env.FRONTEND_URL || 'https://primenationalcredit-ai.github.io/asap-dashboard';
            res.redirect(`${frontendUrl}?connected=true`);
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
        company_id: tokens.realm_id
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
    
    // Refresh if expired or expiring in next 5 minutes
    if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) {
        await refreshAccessToken();
    }
}

// ========== QUICKBOOKS API CALLS ==========

async function qbApiCall(endpoint, method = 'GET') {
    await ensureValidToken();
    
    const url = `${QB_API_BASE}/v3/company/${tokens.realm_id}${endpoint}`;
    
    const response = await fetch(url, {
        method,
        headers: {
            'Authorization': `Bearer ${tokens.access_token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`QB API Error (${endpoint}):`, errorText);
        throw new Error(`QuickBooks API error: ${response.status}`);
    }

    return response.json();
}

// ========== DATA ENDPOINTS ==========

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

// ========== MAIN DATA FETCH ==========

async function fetchFinancialData() {
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const endDate = now.toISOString().split('T')[0];
    const startDate = startOfYear.toISOString().split('T')[0];

    // Fetch P&L Report for monthly summaries
    const plReport = await qbApiCall(
        `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&summarize_column_by=Month`
    );

    // Fetch ALL purchases/expenses with full details
    const purchases = await qbApiCall(
        `/query?query=SELECT * FROM Purchase WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );

    // Fetch ALL bills
    const bills = await qbApiCall(
        `/query?query=SELECT * FROM Bill WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );

    // Fetch ALL bill payments
    const billPayments = await qbApiCall(
        `/query?query=SELECT * FROM BillPayment WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );

    // Fetch vendors for name lookup
    const vendors = await qbApiCall(
        `/query?query=SELECT * FROM Vendor MAXRESULTS 1000`
    );

    // Fetch accounts for category lookup
    const accounts = await qbApiCall(
        `/query?query=SELECT * FROM Account WHERE AccountType IN ('Expense', 'Cost of Goods Sold', 'Other Expense') MAXRESULTS 500`
    );

    // Fetch sales receipts and invoices for income
    const salesReceipts = await qbApiCall(
        `/query?query=SELECT * FROM SalesReceipt WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );

    const payments = await qbApiCall(
        `/query?query=SELECT * FROM Payment WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );

    // Fetch Deposits (bank deposits - often how ACH/merchant payments show up)
    const deposits = await qbApiCall(
        `/query?query=SELECT * FROM Deposit WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );

    // Fetch Invoices for additional income tracking
    const invoices = await qbApiCall(
        `/query?query=SELECT * FROM Invoice WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );

    // Build lookup maps
    const vendorMap = {};
    (vendors.QueryResponse?.Vendor || []).forEach(v => {
        vendorMap[v.Id] = v.DisplayName || v.CompanyName || 'Unknown Vendor';
    });

    const accountMap = {};
    (accounts.QueryResponse?.Account || []).forEach(a => {
        accountMap[a.Id] = {
            name: a.Name,
            type: a.AccountType,
            subType: a.AccountSubType
        };
    });

    // Process transactions with REAL details
    const transactions = [];

    // Process Purchases (credit card charges, checks, etc.)
    (purchases.QueryResponse?.Purchase || []).forEach(p => {
        const vendorName = p.EntityRef?.name || vendorMap[p.EntityRef?.value] || '';
        const memo = p.PrivateNote || '';
        
        // Get line item details
        const lineDetails = (p.Line || []).map(line => {
            if (line.AccountBasedExpenseLineDetail) {
                const acctId = line.AccountBasedExpenseLineDetail.AccountRef?.value;
                const acctName = line.AccountBasedExpenseLineDetail.AccountRef?.name || accountMap[acctId]?.name || '';
                return {
                    description: line.Description || acctName,
                    category: acctName,
                    amount: line.Amount
                };
            }
            if (line.ItemBasedExpenseLineDetail) {
                return {
                    description: line.Description || line.ItemBasedExpenseLineDetail.ItemRef?.name || '',
                    category: 'Items',
                    amount: line.Amount
                };
            }
            return null;
        }).filter(Boolean);

        // If we have line items, create a transaction for each
        if (lineDetails.length > 0) {
            lineDetails.forEach((line, idx) => {
                transactions.push({
                    id: `purchase-${p.Id}-${idx}`,
                    date: p.TxnDate,
                    description: line.description || vendorName || memo || 'Purchase',
                    vendor: vendorName,
                    category: line.category || 'Uncategorized',
                    amount: -Math.abs(line.amount),
                    type: 'expense',
                    paymentType: p.PaymentType || 'Unknown',
                    source: 'Purchase'
                });
            });
        } else {
            // Single transaction without line items
            transactions.push({
                id: `purchase-${p.Id}`,
                date: p.TxnDate,
                description: vendorName || memo || 'Purchase',
                vendor: vendorName,
                category: 'Uncategorized',
                amount: -Math.abs(p.TotalAmt),
                type: 'expense',
                paymentType: p.PaymentType || 'Unknown',
                source: 'Purchase'
            });
        }
    });

    // Process Bills
    (bills.QueryResponse?.Bill || []).forEach(b => {
        const vendorName = b.VendorRef?.name || vendorMap[b.VendorRef?.value] || '';
        const memo = b.PrivateNote || '';

        const lineDetails = (b.Line || []).map(line => {
            if (line.AccountBasedExpenseLineDetail) {
                const acctName = line.AccountBasedExpenseLineDetail.AccountRef?.name || '';
                return {
                    description: line.Description || acctName,
                    category: acctName,
                    amount: line.Amount
                };
            }
            if (line.ItemBasedExpenseLineDetail) {
                return {
                    description: line.Description || line.ItemBasedExpenseLineDetail.ItemRef?.name || '',
                    category: 'Items',
                    amount: line.Amount
                };
            }
            return null;
        }).filter(Boolean);

        if (lineDetails.length > 0) {
            lineDetails.forEach((line, idx) => {
                transactions.push({
                    id: `bill-${b.Id}-${idx}`,
                    date: b.TxnDate,
                    description: line.description || vendorName || memo || 'Bill',
                    vendor: vendorName,
                    category: line.category || 'Uncategorized',
                    amount: -Math.abs(line.amount),
                    type: 'expense',
                    source: 'Bill'
                });
            });
        } else {
            transactions.push({
                id: `bill-${b.Id}`,
                date: b.TxnDate,
                description: vendorName || memo || 'Bill',
                vendor: vendorName,
                category: 'Uncategorized',
                amount: -Math.abs(b.TotalAmt),
                type: 'expense',
                source: 'Bill'
            });
        }
    });

    // Process Sales Receipts (income)
    (salesReceipts.QueryResponse?.SalesReceipt || []).forEach(sr => {
        const customerName = sr.CustomerRef?.name || '';
        transactions.push({
            id: `salesreceipt-${sr.Id}`,
            date: sr.TxnDate,
            description: customerName ? `Payment - ${customerName}` : 'Sales Receipt',
            customer: customerName,
            category: 'Income',
            amount: Math.abs(sr.TotalAmt),
            type: 'income',
            source: 'SalesReceipt'
        });
    });

    // Process Payments (income)
    (payments.QueryResponse?.Payment || []).forEach(p => {
        const customerName = p.CustomerRef?.name || '';
        transactions.push({
            id: `payment-${p.Id}`,
            date: p.TxnDate,
            description: customerName ? `Payment - ${customerName}` : 'Payment Received',
            customer: customerName,
            category: 'Income',
            amount: Math.abs(p.TotalAmt),
            type: 'income',
            source: 'Payment'
        });
    });

    // Process Deposits (bank deposits - ACH, merchant processing, etc.)
    (deposits.QueryResponse?.Deposit || []).forEach(d => {
        // Get line item details from deposit
        const lineDetails = (d.Line || []).map(line => {
            if (line.DepositLineDetail) {
                const customerName = line.DepositLineDetail.Entity?.name || '';
                const memo = line.Description || '';
                return {
                    description: customerName || memo || 'Deposit',
                    customer: customerName,
                    amount: line.Amount
                };
            }
            return null;
        }).filter(Boolean);

        if (lineDetails.length > 0) {
            lineDetails.forEach((line, idx) => {
                transactions.push({
                    id: `deposit-${d.Id}-${idx}`,
                    date: d.TxnDate,
                    description: line.description,
                    customer: line.customer,
                    category: 'Income',
                    amount: Math.abs(line.amount),
                    type: 'income',
                    source: 'Deposit'
                });
            });
        } else {
            // Single deposit without line items
            transactions.push({
                id: `deposit-${d.Id}`,
                date: d.TxnDate,
                description: d.PrivateNote || 'Bank Deposit',
                category: 'Income',
                amount: Math.abs(d.TotalAmt),
                type: 'income',
                source: 'Deposit'
            });
        }
    });

    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Parse P&L for monthly summaries
    const monthlyData = parseMonthlyPL(plReport);

    // Calculate category totals from transactions
    const categoryTotals = {};
    transactions.filter(t => t.type === 'expense').forEach(t => {
        const cat = t.category || 'Uncategorized';
        categoryTotals[cat] = (categoryTotals[cat] || 0) + Math.abs(t.amount);
    });

    const categories = Object.entries(categoryTotals)
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount);

    // Calculate totals
    const totalExpenses = transactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const totalIncome = transactions
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + t.amount, 0);

    return {
        summary: {
            totalIncome,
            totalExpenses,
            netProfit: totalIncome - totalExpenses,
            transactionCount: transactions.length
        },
        monthlyData,
        categories,
        transactions: transactions.slice(0, 500), // Limit to 500 most recent
        expenses: categoryTotals,
        timestamp: Date.now(),
        debug: {
            realm_id: tokens.realm_id,
            date_range: `${startDate} to ${endDate}`,
            purchase_count: purchases.QueryResponse?.Purchase?.length || 0,
            bill_count: bills.QueryResponse?.Bill?.length || 0,
            salesreceipt_count: salesReceipts.QueryResponse?.SalesReceipt?.length || 0,
            payment_count: payments.QueryResponse?.Payment?.length || 0,
            deposit_count: deposits.QueryResponse?.Deposit?.length || 0,
            invoice_count: invoices.QueryResponse?.Invoice?.length || 0
        }
    };
}

function parseMonthlyPL(report) {
    const monthlyData = [];
    
    if (!report?.Rows?.Row) return monthlyData;

    const columns = report.Columns?.Column || [];
    const monthNames = columns.slice(1).map(c => {
        // Extract month from column title (e.g., "Jan 2024")
        const parts = (c.ColTitle || '').split(' ');
        return parts[0] || '';
    });

    let incomeRow = null;
    let expenseRow = null;

    // Find Total Income and Total Expenses rows
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

    incomeRow = findRow(report.Rows.Row, 'Total Income');
    expenseRow = findRow(report.Rows.Row, 'Total Expenses');

    // Build monthly data
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

// ========== START SERVER ==========

async function start() {
    await loadTokens();

    app.listen(PORT, () => {
        console.log(`\n🚀 ASAP Financial Dashboard Backend`);
        console.log(`   Server running on port ${PORT}`);
        console.log(`   Environment: ${QB_ENVIRONMENT}`);
        console.log(`   Connected: ${!!tokens.access_token}`);
        console.log(`\n   Endpoints:`);
        console.log(`   - GET  /api/quickbooks/auth`);
        console.log(`   - GET  /api/quickbooks/callback`);
        console.log(`   - GET  /api/quickbooks/status`);
        console.log(`   - GET  /api/quickbooks/data`);
        console.log(`   - POST /api/quickbooks/refresh`);
        console.log(`   - POST /api/quickbooks/disconnect\n`);
    });
}

start();
