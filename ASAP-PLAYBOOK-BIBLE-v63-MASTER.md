# ASAP PLAYBOOK BIBLE v63 - MASTER DOCUMENT
> **⚠️ CLAUDE: READ THIS ENTIRE DOCUMENT FIRST BEFORE DOING ANYTHING**
> 
> **Last Updated:** January 16, 2026
> **Purpose:** Single source of truth for AI continuity. Contains ALL context needed.

---

## 🚨 CURRENT SESSION STATUS

### Active Issue (January 16, 2026):
**Problem:** Plaid only showing transactions from Nov 2025 onwards. Jan-Oct 2025 showing $0.

**Root Cause:** Newly connected Plaid accounts only have ~90 days of history initially. Full 24-month history becomes available 24-48 hours after connection.

**Solution:** Wait 24-48 hours, then test again. If still missing, may need to use Plaid's `/transactions/refresh` endpoint.

### What Was Just Completed:
- ✅ Plaid integration working (Wells Fargo, Chase, Amex connected)
- ✅ Account exclusion (6 personal WF accounts excluded)
- ✅ Conservative categorization rules (95%+ confidence only)
- ✅ Backend pagination for large transaction sets
- ✅ Bible document created
- ✅ DOO Center with daily/weekly/monthly tasks for Astrid
- ✅ Financial education tips built into interface
- ✅ Professional QuickBooks-style P&L reports
- ✅ CSV transaction export
- ✅ **Supabase storage for Plaid tokens (persistent, survives redeployment)**

### Next Steps:
1. **Run Supabase schema** (`plaid-storage-schema.sql`) in SQL Editor
2. **Add env vars to Railway:** `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
3. Deploy backend v6.1 (will auto-migrate tokens to Supabase)
4. Wait for Plaid history to populate (24-48 hours)
5. Deploy frontend v64 with DOO Center and Reports
6. Test full year P&L accuracy

---

## 📖 HOW TO USE THIS DOCUMENT

**For Claude AI:**
1. Read this ENTIRE document before responding
2. Check "CURRENT SESSION STATUS" for what was just worked on
3. Check "PROJECT STRUCTURE" for file locations
4. Check "CATEGORIZATION RULES" before modifying transaction logic
5. Update "CURRENT SESSION STATUS" at end of each session

**For Joe:**
1. Upload this file + the zip to any new Claude chat
2. Tell Claude: "Read the ASAP-PLAYBOOK-BIBLE first, then continue where we left off"
3. Claude will have full context without re-explanation

---

## 📁 PROJECT STRUCTURE

### Backend (Railway)
```
qb-backend-v6/
├── server.js          # Main Express server with Plaid + QB integration
├── package.json       # Dependencies
└── plaid-tokens.json  # Stored access tokens (gitignored)
```

**Deployed URL:** `https://asap-financial-dashboard-backend-production.up.railway.app`

**GitHub:** `https://github.com/primenationalcredit-ai/asap-financial-dashboard-backend`

### Frontend (Netlify)
```
asap-playbook-ready/
├── src/
│   ├── pages/
│   │   └── FinancialDashboard.jsx   # Main financial dashboard
│   ├── components/
│   ├── context/
│   └── lib/
├── netlify/functions/
├── package.json
└── *.sql                            # Database schemas
```

**Deployed URL:** `https://cute-cat-d9631c.netlify.app`

**GitHub:** `https://github.com/primenationalcredit-ai/Playbook`

---

## 🔑 ENVIRONMENT VARIABLES

### Railway Backend
```
# Plaid Integration
PLAID_CLIENT_ID=<set>
PLAID_SECRET=<set>
PLAID_ENV=production

# AI Categorization
ANTHROPIC_API_KEY=<set>

# QuickBooks (optional)
QB_CLIENT_ID=<set>
QB_CLIENT_SECRET=<set>

# Supabase (for persistent Plaid token storage) - NEW!
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=<your-service-role-key>
```

**⚠️ IMPORTANT:** Use `SUPABASE_SERVICE_KEY` (service role key), NOT the anon key. The service key is needed for server-side database access. Find it in Supabase Dashboard → Settings → API → service_role key.

### Netlify Frontend
```
VITE_SUPABASE_URL=<set>
VITE_SUPABASE_ANON_KEY=<set>
```

---

## 💰 FINANCIAL DASHBOARD - TRANSACTION CATEGORIZATION RULES

### HIGH CONFIDENCE (95%+) - Auto-categorize:

#### TRANSFERS (Exclude from P&L)
These are internal money movements, NOT income or expenses:
```
- "payment thank you" → Transfer
- "online payment - thank you" → Transfer
- "chase credit crd epay" → Transfer
- "american express ach pmt" → Transfer
- "amex epay" → Transfer
```

#### PAYROLL
```
- "paychex" → Payroll
- "wise inc" / "wise us inc" / "trnwise" → Payroll (overseas contractors)
- "xoom debit" → Payroll
- "remitly inc" / "remittance" → Payroll
- "gusto" / "adp" → Payroll
```

#### MERCHANT PROCESSING FEES (COGS)
```
- "ems merch disc" → Merchant Processing Fees
- "signapay" / "pci fees" → Merchant Processing Fees
- "ems dly fees" → Merchant Processing Fees
```

#### AFFILIATE PAYOUTS
```
- "wf direct pay" + "affiliate" → Affiliate Payouts
- "affiliate payout" → Affiliate Payouts
```

#### SOFTWARE/SERVICES (Specific Vendors)
```
- "godaddy" / "go daddy" → Domain & Email Services
- "instantly" → Sales Software
- "smartlead" → Email Marketing Software
- "twilio" / "sendgrid" → Communication/Email Services
- "zapier" → Automation Services
- "zoho" → Invoicing Software
- "insightful" → Employee Monitoring
- "pipedrive" → CRM Software
- "cognito" → Web Forms
- "railway" → Cloud Hosting (NOT transportation!)
- "readyrefresh" → Water Service
- "ringcentral" → Phone Service
- "facebk" / "facebook" → Advertising - Facebook
- "identityiq" / "smart credit" → Credit Reports (COGS)
```

### LOW CONFIDENCE - Send to "Needs Review":
```
- "amazon" → Could be office supplies, personal, anything - NEEDS REVIEW
- "google services" → Could be ads, cloud, other - NEEDS REVIEW  
- "check" → Could be refund, payment, anything - NEEDS REVIEW
- Any transaction not matching above rules → NEEDS REVIEW
```

### IMPORTANT: Avoid Double-Counting
Credit card payments show in TWO places:
1. Bank account: "CHASE CREDIT CRD EPAY $5,000" (money OUT)
2. Credit card: "Payment Thank You $5,000" (payment received)

Both are TRANSFERS - exclude from P&L entirely!

---

## 🎯 CURRENT PRIORITY WORK

### Immediate Tasks:
1. ✅ Plaid integration working
2. ✅ Account exclusion (exclude 6 personal Wells Fargo accounts)
3. ✅ Transaction categorization rules (conservative - 95%+ only)
4. ⏳ Pull full transaction history to Jan 2025
5. ⏳ Update Needs Review tab with learning functionality
6. ⏳ Test P&L accuracy

### Astrid (DOO) Requirements:
- **Expense Flagging:** Flag expenses for review/cancel/negotiate
- **Learning System:** AI remembers categorizations
- **DOO Bonus:** Paid % of Net Profit - needs accurate P&L
- **Cost Cutting:** Help identify subscriptions to cancel/negotiate

---

## 📊 DOO CENTER - ASTRID'S TRAINING SYSTEM

### Purpose:
Help Astrid learn financial management through daily tasks, education, and actionable steps to increase profits and reduce expenses.

### Daily Tasks:
1. **Review New Transactions** - Check Bank Feed for new items
2. **Follow Up on Flagged Items** - Review expenses marked for action
3. **Categorize Unknown Transactions** - Train the AI

### Weekly Tasks:
1. **Audit Subscriptions** - Flag unused ones for cancellation
2. **Compare to Last Month** - Look for unexpected expense increases
3. **Research One Alternative** - Find cheaper options for top expenses

### Monthly Tasks:
1. **Deep Dive P&L Review** - Understand where every dollar goes
2. **Negotiate With One Vendor** - Call and ask for better rates
3. **Generate Monthly Reports** - Create CPA-ready documents
4. **Set Next Month's Goals** - Set targets for improvement

### Educational Features:
- **Learn More** expandable sections on each task
- **Financial Term of the Day** with real examples
- **Bonus Connection** - Shows how savings affect Astrid's bonus
- **Quick Win Strategies** - Actionable cost-cutting tips

### Gamification:
- Daily task streak counter
- Completion checkboxes with visual feedback
- Progress tracking across days/weeks/months

---

## 📄 REPORTS & EXPORT

### Available Reports:
1. **Profit & Loss Statement** - QuickBooks-style PDF
   - Revenue breakdown by category
   - COGS breakdown
   - Operating expenses by category
   - Net Profit calculation
   - Margin analysis

2. **Expense Detail Report** - Detailed breakdown PDF

3. **Transaction Export** - CSV file for Excel/Sheets
   - All transactions with categories
   - Confidence scores
   - Institution information

### CPA-Ready:
Reports are formatted to match QuickBooks output for easy reconciliation and tax preparation.

---

## 📊 PLAID INTEGRATION

### Connected Accounts:
- Wells Fargo (1 of 7 active - business checking only)
- American Express (1 account)
- Chase (1 account)

### API Endpoints:
```
GET  /api/plaid/accounts           # List connected accounts
POST /api/plaid/link-token         # Get link token for Plaid Link
POST /api/plaid/exchange-token     # Exchange public token for access
POST /api/plaid/sync              # Sync new transactions
GET  /api/plaid/transactions      # Get all transactions (default: Jan 2025 - now)
POST /api/plaid/toggle-account    # Include/exclude individual accounts
POST /api/plaid/disconnect        # Disconnect entire institution
```

### Transaction Format:
```javascript
{
  id: "plaid_txn_id",
  date: "2025-01-15",
  description: "PAYCHEX",
  merchant_name: "Paychex",
  amount: 20545.04,  // Positive = expense, Negative = income
  category: "INCOME",  // Plaid's category (often wrong)
  institution: "Wells Fargo",
  smartCategory: "Payroll",  // Our AI category
  smartType: "expense",  // expense | income | cogs | transfer
  confidence: 0.97,
  needsReview: false
}
```

---

## 🧠 AI CATEGORIZATION SYSTEM

### How It Works:
1. Transaction comes in from Plaid
2. Check user's learned categories (localStorage) - 100% confidence
3. Check high-confidence patterns (transfers, payroll, etc.) - 95%+
4. Check vendor-specific rules - 95%+
5. Everything else → "Needs Review" (0% confidence)

### Learning System:
- User categorizes transaction in "Needs Review" tab
- Pattern extracted from merchant/description
- Saved to `localStorage.learnedCategories`
- Applied to future transactions automatically

### Storage:
```javascript
// localStorage key: 'learnedCategories'
{
  "amazon": { category: "Office Supplies", transactionType: "expense", learnedAt: "..." },
  "uber": { category: "Transportation", transactionType: "expense", learnedAt: "..." }
}

// localStorage key: 'flaggedExpenses'
{
  "txn_123": { type: "cancel", note: "", flaggedAt: "...", flaggedBy: "Astrid" }
}
```

---

## 🚀 DEPLOYMENT COMMANDS

### Backend (Railway):
```bash
cd C:\Users\18328\Downloads\qb-backend-v6
rmdir /s /q .git
git init
git add .
git commit -m "v6 - description"
git remote add origin https://github.com/primenationalcredit-ai/asap-financial-dashboard-backend.git
git branch -M main
git push -u origin main --force
```

### Frontend (Netlify):
```bash
cd C:\Users\18328\Downloads\asap-playbook-v62\asap-playbook-ready
rmdir /s /q .git
git init
git add .
git commit -m "v62 - description"
git remote add origin https://github.com/primenationalcredit-ai/Playbook.git
git branch -M main
git push -u origin main --force
```

---

## 📋 SUPABASE DATABASE SCHEMAS

### Main Tables:
- `users` - Employee accounts
- `tasks` - Playbook tasks
- `calendar_events` - Calendar with recurrence
- `training_courses` - Training modules
- `scorecards` - Employee scorecards
- `affiliates` - Affiliate tracking
- `pto_requests` - Time off requests

### Financial Tables (To Add):
```sql
-- Learned AI categorizations (persistent)
CREATE TABLE ai_learned_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  transaction_type TEXT NOT NULL, -- expense, income, cogs, transfer
  learned_by TEXT,
  learned_at TIMESTAMPTZ DEFAULT NOW()
);

-- Flagged expenses for review
CREATE TABLE flagged_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id TEXT NOT NULL UNIQUE,
  flag_type TEXT NOT NULL, -- review, cancel, negotiate, approved
  note TEXT,
  flagged_by TEXT,
  flagged_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Transaction overrides (manual categorizations)
CREATE TABLE transaction_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  override_by TEXT,
  override_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 👥 TEAM CONTEXT

**Joe Mahlow** - CEO, building this system
- Direct communication style
- Frustrated by chat timeouts losing context
- Wants comprehensive documentation
- Building WealthPath app in parallel

**Astrid** - Director of Operations
- Will use Financial Dashboard daily
- Paid bonus based on Net Profit
- Needs to flag/review expenses
- Learning financial management

**Eric** - Technical infrastructure (Joe's brother)

---

## 🔧 KNOWN ISSUES & SOLUTIONS

### Issue: Chat Timeouts
**Solution:** This Bible document. Always read it first on new session.

### Issue: Plaid only showing recent transactions (90 days)
**Solution:** Newly connected accounts have limited history. Call `/api/plaid/refresh` endpoint to request more data. Full history (24 months) available after 24-48 hours.

### Issue: Plaid categorization wrong
**Solution:** Conservative approach - only 95%+ confident categories. Everything else to Needs Review.

### Issue: Double-counting credit card payments
**Solution:** Detect "payment thank you" patterns as TRANSFERS, exclude from P&L.

### Issue: Package-lock.json conflicts
**Solution:** Delete package-lock.json before deploying. Let npm generate fresh.

### Issue: Railway build fails
**Solution:** Check for correct Node version, no package-lock conflicts.

### Issue: Netlify can't find package.json
**Solution:** Make sure you're in `asap-playbook-ready` folder (where package.json is), not the parent folder.

---

## 📈 NEXT STEPS (Priority Order)

1. ⏳ **Wait for Plaid history** - 24-48 hours for full 24-month history
2. **Test P&L accuracy** - Should show correct revenue/expenses
3. **Train AI** - Categorize items in Needs Review
4. **Create Supabase tables** - Run `financial-persistence-schema.sql`
5. **DOO Dashboard** - Add Astrid's bonus calculation
6. **Reports** - Monthly P&L export

---

## 📝 VERSION HISTORY

| Version | Date | Changes |
|---------|------|---------|
| v62 | Jan 16, 2026 | Plaid integration, account management |
| v63 | Jan 16, 2026 | Conservative categorization, Bible system |

---

## 🤖 INSTRUCTIONS FOR CLAUDE AI

### When Starting a New Session:
1. **READ THIS ENTIRE DOCUMENT FIRST**
2. Check "CURRENT SESSION STATUS" at the top
3. Do NOT ask user to re-explain anything documented here
4. Continue from where the last session left off

### When Working on Code:
1. Check file locations in "PROJECT STRUCTURE"
2. Follow categorization rules EXACTLY as documented
3. Test changes before packaging

### When Ending a Session:
1. Update "CURRENT SESSION STATUS" with:
   - What was completed
   - What's still pending
   - Any new issues discovered
2. Package updated files
3. Include updated Bible in the package

### Key Files to Read:
- `ASAP-PLAYBOOK-BIBLE-v63-MASTER.md` - This document (read first!)
- `src/pages/FinancialDashboard.jsx` - Main dashboard code
- `server.js` - Backend API
- `financial-persistence-schema.sql` - Database setup

---

## 📂 FILES INCLUDED IN THIS PACKAGE

```
asap-playbook-ready/
├── ASAP-PLAYBOOK-BIBLE-v63-MASTER.md    ← READ THIS FIRST!
├── src/
│   └── pages/
│       └── FinancialDashboard.jsx        ← Main financial dashboard
├── financial-persistence-schema.sql      ← Run in Supabase
├── package.json
├── netlify.toml
└── ... other files
```

---

## 🔄 SESSION HANDOFF LOG

### January 16, 2026 - Session 1
**Worked On:**
- Plaid integration (Wells Fargo, Chase, Amex)
- Account exclusion feature
- Conservative categorization rules
- Bible documentation system

**Completed:**
- ✅ Backend v6 deployed to Railway
- ✅ Frontend v63 packaged (deployment pending)
- ✅ Account toggle working
- ✅ Categorization rules defined

**Pending:**
- ⏳ Plaid history only showing Nov+ (need to wait 24-48 hrs)
- ⏳ Need to run Supabase schema
- ⏳ Need to train AI on uncategorized transactions

**Blockers:**
- Plaid historical data limitation (automatic resolution in 24-48 hrs)

---

## 🆘 EMERGENCY REFERENCE

### Deployed URLs:
- **Frontend:** https://cute-cat-d9631c.netlify.app
- **Backend:** https://asap-financial-dashboard-backend-production.up.railway.app

### GitHub Repos:
- **Frontend:** https://github.com/primenationalcredit-ai/Playbook
- **Backend:** https://github.com/primenationalcredit-ai/asap-financial-dashboard-backend

### Quick Deploy Commands:
```bash
# Frontend
cd asap-playbook-ready
git init && git add . && git commit -m "update"
git remote add origin https://github.com/primenationalcredit-ai/Playbook.git
git branch -M main && git push -u origin main --force

# Backend
cd qb-backend-v6
git init && git add . && git commit -m "update"
git remote add origin https://github.com/primenationalcredit-ai/asap-financial-dashboard-backend.git
git branch -M main && git push -u origin main --force
```

**DO NOT** ask user to re-explain context. Everything is documented here.
