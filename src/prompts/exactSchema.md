# Exact Database Schema — PostgreSQL DDL

> **CRITICAL**: These are the EXACT table and column names as they exist in PostgreSQL.
> All column names are **camelCase** and MUST be wrapped in double quotes in SQL.
> Do NOT use snake_case. Do NOT invent column names. Use ONLY what is listed here.

---

## Multi-tenancy Rule

Every table below has a `"tenantId"` column. **Always filter by `"tenantId"`** in every
query to scope data to one Xero organisation. Never join rows from different tenants.

---

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_connections
-- INFRASTRUCTURE ONLY — OAuth credentials for Xero API access.
-- ⛔ DO NOT query for financial analysis — no revenue, expense, AR, AP data here.
-- ⛔ NEVER expose "accessToken" or "refreshToken" in query results.
-- USE FOR: checking connection status, last sync time, tenant/user lookup only.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_connections (
  "id"           TEXT        NOT NULL PRIMARY KEY,
  "tenantId"     TEXT        NOT NULL,
  "xeroUserId"   TEXT        NOT NULL,
  "tenantName"   TEXT,
  "tenantType"   TEXT,
  "accessToken"  TEXT        NOT NULL,   -- ⛔ NEVER SELECT THIS
  "refreshToken" TEXT        NOT NULL,   -- ⛔ NEVER SELECT THIS
  "idToken"      TEXT,                   -- ⛔ NEVER SELECT THIS
  "tokenExpiry"  TIMESTAMP,
  "scopes"       TEXT,
  "syncStatus"   TEXT        NOT NULL DEFAULT 'idle',  -- 'idle' | 'syncing' | 'error'
  "lastSyncedAt" TIMESTAMP,
  "connectedAt"  TIMESTAMP   NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMP   NOT NULL,
  UNIQUE ("xeroUserId", "tenantId")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_organisations
-- One row per Xero organisation (one per tenantId).
-- USE FOR: getting currency, financial year, timezone, country context.
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
-- GOTCHAS:
--   • "isDemoCompany" = true means test/demo data — consider adding
--     AND "isDemoCompany" = false in user-facing queries.
--   • "financialYearEndMonth" and "financialYearEndDay" define the org's FY.
--     Always use these (via subquery) rather than hardcoding calendar year.
--   • "baseCurrency" defines the currency for all monetary amounts.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_organisations (
  "id"                     TEXT      NOT NULL PRIMARY KEY,
  "tenantId"               TEXT      NOT NULL UNIQUE,
  "name"                   TEXT,                        -- trading name, e.g. 'Acme Corp'
  "legalName"              TEXT,
  "organisationType"       TEXT,                        -- 'COMPANY' | 'SOLE_TRADER' | 'PARTNERSHIP' | 'TRUST'
  "organisationEntityType" TEXT,
  "organisationStatus"     TEXT,                        -- 'ACTIVE'
  "isDemoCompany"          BOOLEAN   NOT NULL DEFAULT FALSE,  -- filter out demo data if needed
  "edition"                TEXT,
  "version"                TEXT,                        -- 'AU' | 'NZ' | 'UK' | 'US' | 'GLOBAL'
  "baseCurrency"           TEXT,                        -- ISO 4217, e.g. 'AUD', 'USD'
  "countryCode"            TEXT,                        -- ISO 3166, e.g. 'AU', 'US'
  "timezone"               TEXT,                        -- IANA, e.g. 'Australia/Sydney'
  "financialYearEndDay"    INTEGER,                     -- day of month FY ends (e.g. 30)
  "financialYearEndMonth"  INTEGER,                     -- month FY ends: 6=June, 12=December
  "taxNumber"              TEXT,
  "paysTax"                BOOLEAN,
  "salesTaxBasis"          TEXT,                        -- 'ACCRUALS' | 'CASH'
  "salesTaxPeriod"         TEXT,                        -- 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY'
  "periodLockDate"         TIMESTAMP,
  "createdDateUTC"         TIMESTAMP,
  "addresses"              JSONB,
  "paymentTerms"           JSONB,
  "syncedAt"               TIMESTAMP,
  "createdAt"              TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"              TIMESTAMP NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_accounts
-- Chart of Accounts — all ledger accounts for the organisation.
-- USE FOR: categorising revenue/expense by account, account-level reporting.
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
--   AND "status" = 'ACTIVE'              ← always exclude ARCHIVED accounts
-- KEY DISCRIMINATORS (always filter by these for account-type queries):
--   "accountClass" = 'REVENUE'           → income/sales accounts
--   "accountClass" = 'EXPENSE'           → cost/expense accounts
--   "accountClass" = 'ASSET'             → asset accounts (incl. bank)
--   "accountClass" = 'LIABILITY'         → liability accounts
--   "accountClass" = 'EQUITY'            → equity accounts
--   "accountType"  = 'BANK'              → bank/cash accounts only
--   "accountType"  = 'SALES'             → sales revenue accounts
--   "accountType"  = 'OVERHEADS'         → overhead expense accounts
-- GOTCHAS:
--   • ARCHIVED accounts should be excluded with AND "status" = 'ACTIVE'
--   • "code" is the account code (e.g. '200') — use for joining to line items in JSONB
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_accounts (
  "id"                      UUID      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId"               TEXT      NOT NULL UNIQUE,  -- Xero AccountID (UUID string)
  "tenantId"                TEXT      NOT NULL,
  "xeroUserId"              TEXT      NOT NULL,
  "code"                    TEXT,                        -- account code, e.g. '200', 'ACC001'
  "name"                    TEXT      NOT NULL,          -- e.g. 'Sales', 'Bank Account'
  "description"             TEXT,
  "accountClass"            TEXT,                        -- ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
  "accountType"             TEXT,                        -- BANK | CURRENT | FIXED | CURRLIAB | TERMLIAB | SALES | OVERHEADS | DEPRECIATN | DIRECTCOSTS
  "taxType"                 TEXT,
  "enablePaymentsToAccount" BOOLEAN   NOT NULL DEFAULT FALSE,
  "showInExpenseClaims"     BOOLEAN   NOT NULL DEFAULT FALSE,
  "status"                  TEXT,                        -- ACTIVE | ARCHIVED ← always filter ACTIVE
  "updatedDateUtc"          TIMESTAMP,
  "createdAt"               TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"               TIMESTAMP NOT NULL,
  UNIQUE ("accountId", "tenantId")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_contacts
-- ⚠️ DUAL-PURPOSE: stores BOTH customers AND suppliers in the same table.
-- A single contact can be both a customer AND a supplier simultaneously.
-- USE FOR: contact details, customer/supplier analysis, AR/AP attribution.
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
--   AND "isCustomer" = true              ← for customer analysis
--   AND "isSupplier" = true              ← for supplier analysis
-- GOTCHAS:
--   • NEVER query without "isCustomer" or "isSupplier" when doing segmented analysis
--     — mixing customers and suppliers produces nonsense results.
--   • "name" is the join key to "contactName" in invoices/payments/quotes/etc.
--     (these are denormalised text fields — no FK).
--   • Contact names can change in Xero; old invoices keep the old name.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_contacts (
  "id"             UUID      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "contactId"      TEXT      NOT NULL UNIQUE,   -- Xero ContactID
  "tenantId"       TEXT      NOT NULL,
  "xeroUserId"     TEXT      NOT NULL,
  "name"           TEXT      NOT NULL,          -- display name — join key to contactName fields
  "emailAddress"   TEXT,
  "companyNumber"  TEXT,
  "isSupplier"     BOOLEAN   NOT NULL DEFAULT FALSE,  -- true = appears on ACCPAY invoices
  "isCustomer"     BOOLEAN   NOT NULL DEFAULT FALSE,  -- true = appears on ACCREC invoices
  "address"        TEXT,                        -- concatenated address string
  "phone"          TEXT,                        -- concatenated phone string
  "taxNumber"      TEXT,
  "accountNumber"  TEXT,
  "updatedDateUtc" TIMESTAMP,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMP NOT NULL,
  UNIQUE ("contactId", "tenantId")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_items
-- Product/service catalogue (SKU / price list).
-- USE FOR: product-level sales analysis, inventory levels, unit pricing.
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
-- KEY DISCRIMINATORS:
--   "isTrackedAsInventory" = true        ← ONLY filter this for stock/inventory queries
--                                           When false, "quantityOnHand" is meaningless (NULL/0)
-- GOTCHAS:
--   • "unitPrice" is the SELLING price ex-tax.
--   • Purchase price is inside "purchaseDetails" JSONB (key: UnitPrice).
--   • "quantityOnHand" is only meaningful when "isTrackedAsInventory" = true.
--   • "totalCostPool" = total cost of current stock (quantityOnHand × avg cost).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_items (
  "id"                        UUID      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "itemId"                    TEXT      NOT NULL,
  "tenantId"                  TEXT      NOT NULL,
  "xeroUserId"                TEXT      NOT NULL,
  "code"                      TEXT,             -- SKU / item code
  "name"                      TEXT,
  "description"               TEXT,
  "inventoryAssetAccountCode" TEXT,
  "purchaseDetails"           JSONB,            -- keys: UnitPrice, AccountCode, TaxType, COGSAccountCode
  "unitPrice"                 NUMERIC(18,4),    -- default selling price ex-tax
  "totalCostPool"             NUMERIC(18,4),    -- total cost of on-hand stock
  "quantityOnHand"            NUMERIC(18,4),    -- only valid when isTrackedAsInventory = true
  "isTrackedAsInventory"      BOOLEAN   NOT NULL DEFAULT FALSE,
  "updatedDateUtc"            TIMESTAMP,
  "createdAt"                 TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"                 TIMESTAMP NOT NULL,
  UNIQUE ("itemId", "tenantId")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_invoices  ← PRIMARY FINANCIAL TABLE
-- ⚠️ DUAL-PURPOSE: stores BOTH sales invoices AND purchase bills in one table.
--   type = 'ACCREC' → Sales Invoice  (REVENUE — customers owe YOU money)
--   type = 'ACCPAY' → Purchase Bill  (EXPENSE — YOU owe suppliers money)
-- MANDATORY FILTERS (ALWAYS apply both):
--   1. WHERE "tenantId" = '<tenantId>'
--   2. AND "type" = 'ACCREC'            ← for revenue / AR / customer queries
--      OR "type" = 'ACCPAY'             ← for expenses / AP / supplier queries
--      (omit ONLY for P&L that needs both sides)
-- STATUS FILTERS — choose based on intent:
--   For P&L / revenue totals:  AND "status" IN ('AUTHORISED', 'PAID')
--   For AR/AP balance (what's owed): AND "status" NOT IN ('DRAFT', 'VOIDED', 'DELETED')
--     ↑ This includes SUBMITTED invoices which can have a real outstanding balance
-- KEY MONEY FIELDS (all NUMERIC(18,4) — always ROUND to 2 dp):
--   "total"      = gross inc. tax  → USE THIS for revenue/expense totals
--   "subTotal"   = net ex. tax     → use only when user asks for "ex-tax" / "net"
--   "totalTax"   = tax component only
--   "amountDue"  = current outstanding balance (decreases as payments received)
--   "amountPaid" = cash collected/paid so far
-- DATE FIELDS (all TIMESTAMP — cast to ::date for arithmetic):
--   "date"            = invoice/bill raised date (use for accrual-basis reporting)
--   "dueDate"         = payment due date (can be NULL — always guard with IS NOT NULL)
--   "fullyPaidOnDate" = when fully settled (NULL if unpaid — guard with IS NOT NULL)
-- DENORMALISED FIELDS (from first line item only — multi-line invoices use lineItems JSONB):
--   "description", "quantity", "unitAmount"
-- JOIN TO CONTACTS: "contactName" = xero_contacts."name" AND same "tenantId" (LEFT JOIN only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_invoices (
  "id"              UUID      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "compositeId"     TEXT      NOT NULL UNIQUE,  -- invoiceId + '_' + tenantId
  "invoiceId"       TEXT      NOT NULL,
  "tenantId"        TEXT      NOT NULL,
  "xeroUserId"      TEXT      NOT NULL,
  "type"            TEXT,                        -- ⚠️ 'ACCREC'=revenue | 'ACCPAY'=expense — ALWAYS FILTER
  "contactName"     TEXT,                        -- denormalised from xero_contacts."name"
  "invoiceNumber"   TEXT,
  "reference"       TEXT,
  "status"          TEXT,                        -- DRAFT|SUBMITTED|AUTHORISED|PAID|VOIDED|DELETED
  "date"            TIMESTAMP,                   -- invoice date — use for accrual-basis
  "dueDate"         TIMESTAMP,                   -- payment due date (can be NULL)
  "fullyPaidOnDate" TIMESTAMP,                   -- date fully settled (NULL if unpaid)
  "subTotal"        NUMERIC(18,4) NOT NULL DEFAULT 0,   -- net ex-tax
  "totalTax"        NUMERIC(18,4) NOT NULL DEFAULT 0,   -- tax only
  "total"           NUMERIC(18,4) NOT NULL DEFAULT 0,   -- gross inc-tax ← USE THIS
  "amountDue"       NUMERIC(18,4) NOT NULL DEFAULT 0,   -- outstanding balance
  "amountPaid"      NUMERIC(18,4) NOT NULL DEFAULT 0,   -- collected/paid so far
  "description"     TEXT,                        -- first line item description (denormalised)
  "quantity"        NUMERIC(18,4),               -- first line item quantity (denormalised)
  "unitAmount"      NUMERIC(18,4),               -- first line item unit price (denormalised)
  "currencyCode"    TEXT,
  "updatedDateUtc"  TIMESTAMP,
  "createdAt"       TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMP NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_credit_notes
-- ⚠️ DUAL-PURPOSE: stores BOTH customer credits AND supplier credits.
--   type = 'ACCRECCREDIT' → Customer credit note (reduces AR — refund issued to customer)
--   type = 'ACCPAYCREDIT' → Supplier credit note (reduces AP — supplier credited you)
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
--   AND "type" = 'ACCRECCREDIT'          ← customer refunds / net revenue adjustment
--   AND "type" = 'ACCPAYCREDIT'          ← supplier credits received
-- STATUS FILTERS:
--   For historical analysis: AND "status" IN ('AUTHORISED', 'PAID')
--   For current balances:    AND "status" NOT IN ('DRAFT', 'VOIDED', 'DELETED')
-- GOTCHAS:
--   • Always subtract ACCRECCREDIT totals from ACCREC invoice totals for NET revenue.
--   • "dueDate" here actually stores "FullyPaidOnDate" from Xero (naming inconsistency).
--   • Full line item detail is in "lineItems" JSONB.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_credit_notes (
  "id"               UUID      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "compositeId"      TEXT      NOT NULL UNIQUE,
  "creditNoteId"     TEXT      NOT NULL,
  "tenantId"         TEXT      NOT NULL,
  "xeroUserId"       TEXT      NOT NULL,
  "type"             TEXT,                        -- ⚠️ 'ACCRECCREDIT'=customer | 'ACCPAYCREDIT'=supplier
  "creditNoteNumber" TEXT,
  "contactName"      TEXT,
  "status"           TEXT,                        -- DRAFT|SUBMITTED|AUTHORISED|PAID|VOIDED
  "date"             TIMESTAMP,
  "dueDate"          TIMESTAMP,                   -- ⚠️ actually stores FullyPaidOnDate from Xero
  "subTotal"         NUMERIC(18,4) NOT NULL DEFAULT 0,
  "totalTax"         NUMERIC(18,4) NOT NULL DEFAULT 0,
  "total"            NUMERIC(18,4) NOT NULL DEFAULT 0,
  "lineItems"        JSONB,                       -- full line items array
  "description"      TEXT,                        -- first line item (denormalised)
  "quantity"         NUMERIC(18,4),
  "unitAmount"       NUMERIC(18,4),
  "updatedDateUtc"   TIMESTAMP,
  "createdAt"        TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"        TIMESTAMP NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_purchase_orders
-- Purchase orders raised to suppliers (pre-bill stage).
-- USE FOR: committed spend analysis, procurement tracking, PO-to-bill conversion.
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
-- STATUS FILTERS:
--   For committed spend:      AND "status" IN ('AUTHORISED', 'BILLED')
--   For open/unfulfilled POs: AND "status" = 'AUTHORISED'
--   For converted POs:        AND "status" = 'BILLED'
--   Exclude: DRAFT, SUBMITTED, DELETED
-- GOTCHAS:
--   • A BILLED PO means it has been converted to a bill in xero_invoices (ACCPAY).
--   • Full line items (quantities, unit prices per item) are in "lineItems" JSONB.
--   • "deliveryDate" and "expectedArrivalDate" can both be NULL.
--   • No contact FK — join via "contactName" = xero_contacts."name" (LEFT JOIN).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_purchase_orders (
  "id"                   UUID      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "purchaseOrderId"      TEXT      NOT NULL,
  "tenantId"             TEXT      NOT NULL,
  "xeroUserId"           TEXT      NOT NULL,
  "purchaseOrderNumber"  TEXT,
  "contactName"          TEXT,
  "reference"            TEXT,
  "status"               TEXT,                    -- DRAFT|SUBMITTED|AUTHORISED|BILLED|DELETED
  "date"                 TIMESTAMP,
  "deliveryDate"         TIMESTAMP,               -- can be NULL
  "expectedArrivalDate"  TIMESTAMP,               -- can be NULL
  "deliveryAddresses"    TEXT,
  "deliveryInstructions" TEXT,
  "telephone"            TEXT,
  "lineItems"            JSONB,                   -- full line items with quantities and prices
  "subTotal"             NUMERIC(18,4) NOT NULL DEFAULT 0,
  "totalTax"             NUMERIC(18,4) NOT NULL DEFAULT 0,
  "total"                NUMERIC(18,4) NOT NULL DEFAULT 0,
  "currencyCode"         TEXT,
  "updatedDateUtc"       TIMESTAMP,
  "createdAt"            TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"            TIMESTAMP NOT NULL,
  UNIQUE ("purchaseOrderId", "tenantId")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_quotes
-- Sales quotes/proposals sent to prospective customers.
-- USE FOR: sales pipeline analysis, win/loss rates, quote-to-invoice conversion.
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
-- STATUS FILTERS (choose by intent):
--   Won deals:       AND "status" IN ('ACCEPTED', 'INVOICED')
--   Active pipeline: AND "status" IN ('SENT', 'ACCEPTED', 'INVOICED')
--   Lost:            AND "status" = 'DECLINED'
--   All sent:        AND "status" IN ('SENT', 'ACCEPTED', 'INVOICED', 'DECLINED')
--   Exclude: DRAFT, DELETED
-- GOTCHAS:
--   • "status" = 'INVOICED' means the quote was converted to an invoice (won and billed).
--   • "expiryDate" can be NULL — guard with IS NOT NULL in date arithmetic.
--   • Money fields ("subTotal", "totalTax", "total") are nullable — use COALESCE(..., 0).
--   • Full quote detail including line items is in "quoteData" JSONB.
--   • These are ESTIMATES only — actual revenue comes from xero_invoices.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_quotes (
  "id"             UUID      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "quoteId"        TEXT      NOT NULL,
  "tenantId"       TEXT      NOT NULL,
  "xeroUserId"     TEXT      NOT NULL,
  "quoteNumber"    TEXT,
  "contactName"    TEXT,
  "status"         TEXT,                          -- DRAFT|SENT|DECLINED|ACCEPTED|INVOICED|DELETED
  "date"           TIMESTAMP,
  "expiryDate"     TIMESTAMP,                     -- can be NULL — guard with IS NOT NULL
  "subTotal"       NUMERIC(18,4),                 -- nullable — use COALESCE("subTotal", 0)
  "totalTax"       NUMERIC(18,4),                 -- nullable — use COALESCE("totalTax", 0)
  "total"          NUMERIC(18,4),                 -- nullable — use COALESCE("total", 0)
  "quoteData"      JSONB,                         -- full quote JSON including line items
  "updatedDateUtc" TIMESTAMP,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMP NOT NULL,
  UNIQUE ("quoteId", "tenantId")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_bank_transactions
-- ⚠️ DUAL-PURPOSE: Direct bank movements NOT linked to invoices.
--   type = 'RECEIVE' → money IN  to the bank account (cash receipts)
--   type = 'SPEND'   → money OUT of the bank account (cash payments)
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
--   AND "type" = 'RECEIVE'               ← for cash inflows
--   AND "type" = 'SPEND'                 ← for cash outflows
-- GOTCHAS:
--   • These are NOT linked to invoices — they are raw bank movements.
--     Use xero_payments for invoice settlement data.
--   • "bankAccount" JSONB contains AccountID, Code, Name of the bank account.
--   • "isReconciled" = true means the transaction matches a bank statement line.
--   • "lineItems" JSONB contains the coding (account, tax type) per line.
--   • No status filter needed — all rows are valid completed bank movements.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_bank_transactions (
  "id"                TEXT      NOT NULL PRIMARY KEY,
  "compositeId"       TEXT      NOT NULL UNIQUE,
  "bankTransactionId" TEXT      NOT NULL,
  "tenantId"          TEXT      NOT NULL,
  "xeroUserId"        TEXT      NOT NULL,
  "type"              TEXT,                            -- ⚠️ 'RECEIVE'=money in | 'SPEND'=money out
  "contactName"       TEXT,
  "bankAccount"       JSONB,                           -- keys: AccountID, Code, Name
  "date"              TIMESTAMP,
  "reference"         TEXT,
  "subTotal"          NUMERIC(18,4) NOT NULL DEFAULT 0,
  "totalTax"          NUMERIC(18,4) NOT NULL DEFAULT 0,
  "total"             NUMERIC(18,4) NOT NULL DEFAULT 0,
  "lineItems"         JSONB,
  "isReconciled"      BOOLEAN   NOT NULL DEFAULT FALSE,
  "currencyCode"      TEXT,
  "updatedDateUtc"    TIMESTAMP,
  "createdAt"         TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"         TIMESTAMP NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_payments
-- ⚠️ DUAL-PURPOSE: records of cash actually received/paid against invoices.
--   paymentType = 'ACCRECPAYMENT'   → customer paid an invoice      (cash IN)
--   paymentType = 'ACCPAYPAYMENT'   → business paid a supplier bill (cash OUT)
--   paymentType = 'APCREDITPAYMENT' → supplier credit applied to a bill
--   paymentType = 'ARCREDITPAYMENT' → customer credit applied to an invoice
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
--   AND "paymentType" = 'ACCRECPAYMENT'  ← cash received from customers
--   AND "paymentType" = 'ACCPAYPAYMENT'  ← cash paid to suppliers
-- DO NOT mix paymentTypes in a SUM — each represents a different cashflow direction.
-- USE FOR: cash-basis reporting, DSO/DPO, days-to-pay analysis.
-- GOTCHAS:
--   • "amount" is always positive regardless of direction — use paymentType to determine direction.
--   • "date" is the CASH date (use for cash-basis reporting vs invoice "date" for accrual).
--   • "invoiceNumber" links to xero_invoices."invoiceNumber" (text match, no FK).
--   • "invoice" JSONB has InvoiceID, InvoiceNumber, Type, AmountDue, AmountPaid.
--   • "account" JSONB has AccountID, Code (the bank account debited/credited).
--   • No status filter needed — all rows are completed payments.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_payments (
  "id"             UUID      NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "compositeId"    TEXT      NOT NULL UNIQUE,
  "paymentId"      TEXT      NOT NULL,
  "tenantId"       TEXT      NOT NULL,
  "xeroUserId"     TEXT      NOT NULL,
  "invoiceNumber"  TEXT,                          -- join key to xero_invoices."invoiceNumber"
  "invoice"        JSONB,                         -- keys: InvoiceID, InvoiceNumber, Type, AmountDue, AmountPaid
  "account"        JSONB,                         -- keys: AccountID, Code (bank account used for payment)
  "date"           TIMESTAMP,                     -- cash date (use for cash-basis reporting)
  "amount"         NUMERIC(18,4) NOT NULL DEFAULT 0,  -- always positive — direction = paymentType
  "paymentType"    TEXT,                          -- ⚠️ ACCRECPAYMENT | ACCPAYPAYMENT | APCREDITPAYMENT | ARCREDITPAYMENT
  "reference"      TEXT,
  "updatedDateUtc" TIMESTAMP,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMP NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: xero_sync_runs
-- OPERATIONAL MONITORING ONLY — audit log of Xero data sync jobs.
-- ⛔ DO NOT query for financial analysis — no revenue, expense, or balance data.
-- USE FOR: checking data freshness, diagnosing sync failures.
-- MANDATORY FILTERS:
--   WHERE "tenantId" = '<tenantId>'
-- KEY VALUES:
--   "status" = 'complete'  → successful sync
--   "status" = 'failed'    → failed sync — check "failedAtLevel" and "errorMessage"
--   "status" = 'running'   → sync in progress
--   "failedAtLevel"        → 0=accounts, 1=contacts, 2=invoices, 3=payments, 4=items, 5=other
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE xero_sync_runs (
  "id"            TEXT      NOT NULL PRIMARY KEY,
  "tenantId"      TEXT      NOT NULL,
  "status"        TEXT      NOT NULL,             -- 'running' | 'complete' | 'failed'
  "startedAt"     TIMESTAMP NOT NULL,
  "completedAt"   TIMESTAMP,
  "failedAtLevel" INTEGER,                        -- 0=accounts 1=contacts 2=invoices 3=payments 4=items
  "errorMessage"  TEXT,
  "recordsSynced" INTEGER   NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

## Quick Reference: Key Join Patterns

```sql
-- Invoices → Contacts (no FK, use LEFT JOIN + tenantId)
LEFT JOIN xero_contacts xc
  ON xi."contactName" = xc."name"
  AND xi."tenantId"   = xc."tenantId"

-- Payments → Invoices (no FK, use LEFT JOIN + tenantId)
LEFT JOIN xero_invoices xi
  ON xp."invoiceNumber" = xi."invoiceNumber"
  AND xp."tenantId"     = xi."tenantId"

-- Any table → Organisation (to get currency/FY info)
LEFT JOIN xero_organisations xo
  ON xt."tenantId" = xo."tenantId"
```

## Quick Reference: Financial Calculations

```sql
-- Revenue  → xero_invoices WHERE "type" = 'ACCREC' AND "status" IN ('AUTHORISED','PAID')
-- Expenses → xero_invoices WHERE "type" = 'ACCPAY' AND "status" IN ('AUTHORISED','PAID')
-- Profit   → SUM(CASE WHEN "type"='ACCREC' THEN "total" ELSE -"total" END)
-- AR owed  → "type"='ACCREC' AND "amountDue">0 AND "status" NOT IN ('DRAFT','VOIDED','DELETED')
-- AP owed  → "type"='ACCPAY' AND "amountDue">0 AND "status" NOT IN ('DRAFT','VOIDED','DELETED')
-- Cash in  → xero_payments WHERE "paymentType" = 'ACCRECPAYMENT'
-- Cash out → xero_payments WHERE "paymentType" = 'ACCPAYPAYMENT'
-- Net rev  → ACCREC invoices total MINUS ACCRECCREDIT credit notes total
```
