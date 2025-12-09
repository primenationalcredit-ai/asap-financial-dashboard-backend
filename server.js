const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

const QB_CLIENT_ID = 'ABlvo2Ct9EVpIvCAlMxuzVQITLsKwGl6r25k4W01DUSw5iLVOM';
const QB_CLIENT_SECRET = 'RaEiwVXav0RocxjANNkI5IoKpiP26Svnza4dRiyr';
const REDIRECT_URI = 'https://asap-financial-dashboard-backend-production-b444.up.railway.app/api/quickbooks/callback';

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com/v3/company';

const TOKEN_FILE = path.join('/tmp', 'tokens.json');
const DATA_FILE = path.join('/tmp', 'financial_data.json');

app.use(cors());
app.use(express.json());

var tokens = { access_token: null, refresh_token: null, expires_at: null, realm_id: null };

async function loadTokens() {
    try {
        var data = await fs.readFile(TOKEN_FILE, 'utf8');
        tokens = JSON.parse(data);
        console.log('Loaded saved tokens, realm_id:', tokens.realm_id);
    } catch (err) {
        console.log('No saved tokens found');
    }
}

async function saveTokens() {
    try {
        await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
        console.log('Tokens saved');
    } catch (err) {
        console.error('Error saving tokens:', err);
    }
}

async function refreshAccessToken() {
    if (!tokens.refresh_token) throw new Error('No refresh token available');
    var credentials = Buffer.from(QB_CLIENT_ID + ':' + QB_CLIENT_SECRET).toString('base64');
    var response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Authorization': 'Basic ' + credentials },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    });
    if (!response.ok) throw new Error('Token refresh failed: ' + await response.text());
    var data = await response.json();
    tokens.access_token = data.access_token;
    tokens.refresh_token = data.refresh_token;
    tokens.expires_at = Date.now() + (data.expires_in * 1000);
    await saveTokens();
}

async function getAccessToken() {
    if (!tokens.access_token) throw new Error('Not authenticated');
    if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) await refreshAccessToken();
    return tokens.access_token;
}

async function qbRequest(endpoint) {
    var accessToken = await getAccessToken();
    var url = API_BASE + '/' + tokens.realm_id + endpoint;
    console.log('QB Request:', url);
    var response = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
    });
    if (!response.ok) {
        var errText = await response.text();
        console.error('QB API error:', errText);
        throw new Error('QB API error: ' + errText);
    }
    return response.json();
}

async function qbQuery(query) {
    return qbRequest('/query?query=' + encodeURIComponent(query));
}

app.get('/', function(req, res) {
    res.json({ status: 'ok', message: 'ASAP Financial Dashboard Backend', realm_id: tokens.realm_id });
});

app.get('/api/quickbooks/auth', function(req, res) {
    var authUrl = AUTH_URL + '?client_id=' + QB_CLIENT_ID + '&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=' + encodeURIComponent(REDIRECT_URI) + '&state=asap';
    res.json({ authUrl: authUrl });
});

app.get('/api/quickbooks/callback', async function(req, res) {
    var code = req.query.code;
    var realmId = req.query.realmId;
    console.log('Callback received, code:', code ? 'yes' : 'no', 'realmId:', realmId);
    if (!code) return res.status(400).json({ error: 'Missing code' });
    try {
        var credentials = Buffer.from(QB_CLIENT_ID + ':' + QB_CLIENT_SECRET).toString('base64');
        var response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Authorization': 'Basic ' + credentials },
            body: new URLSearchParams({ grant_type: 'authorization_code', code: code, redirect_uri: REDIRECT_URI })
        });
        var text = await response.text();
        console.log('Token response:', response.status);
        if (!response.ok) throw new Error('Token exchange failed: ' + text);
        var data = JSON.parse(text);
        tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in * 1000), realm_id: realmId };
        await saveTokens();
        // Clear cached data so fresh data is fetched
        try { await fs.unlink(DATA_FILE); } catch(e) {}
        res.redirect('https://primenationalcredit-ai.github.io/asap-dashboard/?connected=true');
    } catch (err) {
        console.error('Callback error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/quickbooks/status', function(req, res) {
    res.json({ connected: !!tokens.access_token, company_id: tokens.realm_id });
});

// Changed to GET so it's easier to call from browser
app.get('/api/quickbooks/disconnect', async function(req, res) {
    tokens = { access_token: null, refresh_token: null, expires_at: null, realm_id: null };
    await saveTokens();
    try { await fs.unlink(DATA_FILE); } catch(e) {}
    res.json({ success: true, message: 'Disconnected from QuickBooks' });
});

app.get('/api/quickbooks/data', async function(req, res) {
    try {
        // Check for cached data (cache for 5 minutes instead of 1 hour for fresher data)
        try {
            var cached = await fs.readFile(DATA_FILE, 'utf8');
            var cdata = JSON.parse(cached);
            if (cdata.timestamp && Date.now() - cdata.timestamp < 300000) {
                console.log('Returning cached data');
                return res.json(cdata);
            }
        } catch (e) {}
        var data = await fetchFinancialData();
        res.json(data);
    } catch (err) {
        console.error('Data error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Force refresh endpoint - bypasses cache
app.get('/api/quickbooks/refresh', async function(req, res) {
    try {
        try { await fs.unlink(DATA_FILE); } catch(e) {}
        var data = await fetchFinancialData();
        res.json(data);
    } catch (err) {
        console.error('Refresh error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function parsePLReport(report) {
    var totalIncome = 0;
    var totalExpenses = 0;
    var categories = [];
    
    try {
        if (report && report.Rows && report.Rows.Row) {
            report.Rows.Row.forEach(function(section) {
                if (section.group === 'Income' || section.Summary) {
                    // Look for Income section
                    if (section.group === 'Income' && section.Summary && section.Summary.ColData) {
                        var incomeVal = section.Summary.ColData[1];
                        if (incomeVal && incomeVal.value) {
                            totalIncome = parseFloat(incomeVal.value) || 0;
                        }
                    }
                }
                if (section.group === 'Expenses' && section.Summary && section.Summary.ColData) {
                    var expenseVal = section.Summary.ColData[1];
                    if (expenseVal && expenseVal.value) {
                        totalExpenses = parseFloat(expenseVal.value) || 0;
                    }
                    // Parse expense categories
                    if (section.Rows && section.Rows.Row) {
                        section.Rows.Row.forEach(function(row) {
                            if (row.ColData && row.ColData[0] && row.ColData[1]) {
                                var name = row.ColData[0].value;
                                var amount = parseFloat(row.ColData[1].value) || 0;
                                if (name && amount > 0) {
                                    categories.push({ name: name, amount: amount });
                                }
                            }
                            // Handle nested categories
                            if (row.Rows && row.Rows.Row) {
                                row.Rows.Row.forEach(function(subrow) {
                                    if (subrow.ColData && subrow.ColData[0] && subrow.ColData[1]) {
                                        var subname = subrow.ColData[0].value;
                                        var subamount = parseFloat(subrow.ColData[1].value) || 0;
                                        if (subname && subamount > 0) {
                                            categories.push({ name: subname, amount: subamount });
                                        }
                                    }
                                });
                            }
                        });
                    }
                }
                // Also check for NetIncome section
                if (section.group === 'NetIncome' && section.Summary && section.Summary.ColData) {
                    // This gives us the final net income
                }
            });
        }
    } catch (e) {
        console.error('Error parsing P&L report:', e);
    }
    
    // Sort categories by amount descending and take top 5
    categories.sort(function(a, b) { return b.amount - a.amount; });
    categories = categories.slice(0, 5);
    
    // Assign colors
    var colors = ['#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6', '#64748b'];
    categories = categories.map(function(cat, idx) {
        return { name: cat.name, amount: cat.amount, color: colors[idx] || '#64748b' };
    });
    
    return { totalIncome: totalIncome, totalExpenses: totalExpenses, categories: categories };
}

async function fetchFinancialData() {
    console.log('Fetching QuickBooks data for realm:', tokens.realm_id);
    var now = new Date();
    var year = now.getFullYear();
    var startDate = year + '-01-01';
    var endDate = now.toISOString().split('T')[0];
    
    // Fetch P&L report for YTD
    console.log('Fetching P&L report from', startDate, 'to', endDate);
    var plReport = await qbRequest('/reports/ProfitAndLoss?start_date=' + startDate + '&end_date=' + endDate);
    console.log('P&L Report received');
    
    // Parse the P&L report
    var plData = parsePLReport(plReport);
    console.log('Parsed P&L - Income:', plData.totalIncome, 'Expenses:', plData.totalExpenses);
    
    // If parsing failed, try to get totals from the raw report header
    if (plData.totalIncome === 0 && plReport) {
        console.log('Trying alternative parsing method...');
        // Log the report structure for debugging
        console.log('Report structure:', JSON.stringify(plReport).substring(0, 500));
    }
    
    // Fetch monthly P&L for chart data
    var months = [];
    var monthlyData = [];
    for (var i = 5; i >= 0; i--) {
        var d = new Date(year, now.getMonth() - i, 1);
        var monthStart = d.toISOString().split('T')[0];
        var monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
        months.push({
            name: d.toLocaleString('default', { month: 'short' }),
            start: monthStart,
            end: monthEnd
        });
    }
    
    // Fetch P&L for each month
    for (var j = 0; j < months.length; j++) {
        try {
            var monthPL = await qbRequest('/reports/ProfitAndLoss?start_date=' + months[j].start + '&end_date=' + months[j].end);
            var monthData = parsePLReport(monthPL);
            monthlyData.push({
                month: months[j].name,
                revenue: monthData.totalIncome,
                expenses: monthData.totalExpenses,
                profit: monthData.totalIncome - monthData.totalExpenses
            });
        } catch (e) {
            console.error('Error fetching month', months[j].name, e.message);
            monthlyData.push({
                month: months[j].name,
                revenue: 0,
                expenses: 0,
                profit: 0
            });
        }
    }
    
    // Fetch recent transactions
    var transactions = [];
    try {
        var purchases = await qbQuery("SELECT * FROM Purchase ORDER BY TxnDate DESC MAXRESULTS 20");
        var purchaseList = (purchases && purchases.QueryResponse && purchases.QueryResponse.Purchase) || [];
        purchaseList.forEach(function(p, i) {
            transactions.push({
                id: 'exp-' + i,
                date: p.TxnDate,
                description: p.PrivateNote || p.DocNumber || 'Expense',
                category: 'Expense',
                amount: -(p.TotalAmt || 0),
                type: 'expense'
            });
        });
    } catch (e) {
        console.error('Error fetching purchases:', e.message);
    }
    
    try {
        var payments = await qbQuery("SELECT * FROM Payment ORDER BY TxnDate DESC MAXRESULTS 20");
        var paymentList = (payments && payments.QueryResponse && payments.QueryResponse.Payment) || [];
        paymentList.forEach(function(p, i) {
            transactions.push({
                id: 'inc-' + i,
                date: p.TxnDate,
                description: p.PrivateNote || 'Payment Received',
                category: 'Income',
                amount: p.TotalAmt || 0,
                type: 'income'
            });
        });
    } catch (e) {
        console.error('Error fetching payments:', e.message);
    }
    
    // Sort transactions by date
    transactions.sort(function(a, b) {
        return new Date(b.date) - new Date(a.date);
    });
    transactions = transactions.slice(0, 10);
    
    // Calculate totals from monthly data if P&L parsing failed
    var totalRevenue = plData.totalIncome;
    var totalExpenses = plData.totalExpenses;
    
    if (totalRevenue === 0) {
        totalRevenue = monthlyData.reduce(function(sum, m) { return sum + m.revenue; }, 0);
        totalExpenses = monthlyData.reduce(function(sum, m) { return sum + m.expenses; }, 0);
    }
    
    var netProfit = totalRevenue - totalExpenses;
    
    // Calculate month-over-month changes
    var lastMonth = monthlyData[monthlyData.length - 1] || { revenue: 0, expenses: 0, profit: 0 };
    var prevMonth = monthlyData[monthlyData.length - 2] || { revenue: 1, expenses: 1, profit: 1 };
    
    var revenueChange = prevMonth.revenue > 0 ? ((lastMonth.revenue - prevMonth.revenue) / prevMonth.revenue * 100) : 0;
    var expensesChange = prevMonth.expenses > 0 ? ((lastMonth.expenses - prevMonth.expenses) / prevMonth.expenses * 100) : 0;
    var profitChange = prevMonth.profit > 0 ? ((lastMonth.profit - prevMonth.profit) / prevMonth.profit * 100) : 0;
    
    // Use parsed categories or defaults
    var categories = plData.categories.length > 0 ? plData.categories : [
        { name: 'Uncategorized', amount: totalExpenses, color: '#64748b' }
    ];
    
    var result = {
        summary: {
            totalRevenue: totalRevenue,
            totalExpenses: totalExpenses,
            netProfit: netProfit,
            revenueChange: Math.round(revenueChange * 10) / 10,
            expensesChange: Math.round(expensesChange * 10) / 10,
            profitChange: Math.round(profitChange * 10) / 10
        },
        monthlyData: monthlyData,
        categories: categories,
        transactions: transactions,
        timestamp: Date.now(),
        debug: {
            realm_id: tokens.realm_id,
            date_range: startDate + ' to ' + endDate,
            raw_income: plData.totalIncome,
            raw_expenses: plData.totalExpenses
        }
    };
    
    await fs.writeFile(DATA_FILE, JSON.stringify(result, null, 2));
    console.log('Data saved. Revenue:', totalRevenue, 'Expenses:', totalExpenses);
    return result;
}

loadTokens().then(function() {
    app.listen(PORT, function() {
        console.log('Server running on port ' + PORT);
        console.log('Client ID: ' + QB_CLIENT_ID.substring(0, 10) + '...');
        console.log('Redirect URI: ' + REDIRECT_URI);
    });
});
