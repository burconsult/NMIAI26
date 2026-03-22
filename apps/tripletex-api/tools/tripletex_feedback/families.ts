import type { FamilyId, FamilyInsight } from "./types.js";

export const FAMILY_INSIGHTS: FamilyInsight[] = [
  {
    id: "employee_create",
    label: "Employee Creation",
    priority: "medium",
    nextAction:
      "Keep employee creation deterministic: create the employee, create the employment row, and verify email, birth date, and employment start date by returned ID. Use this family when prompts are plain employee master-data tasks rather than attachment onboarding.",
    canaryNeeded: false,
    keywords: ["employee", "ansatt", "arbeidstakar", "tilsett", "funcionário", "funcionario", "empregado", "empleado", "employé", "mitarbeiter"],
    openApiPatterns: [/^\/employee/i, /^\/employee\/employment/i],
    sandboxKeywords: ["employee", "employment"],
  },
  {
    id: "salary_transaction",
    label: "Payroll / Salary Transaction",
    priority: "high",
    nextAction:
      "Keep payroll detection multilingual and deterministic: resolve or create the employee, then create the salary transaction with exact base-salary and bonus verification.",
    canaryNeeded: true,
    keywords: ["payroll", "salary", "lønn", "paie", "nómina", "nomina", "bonus", "bonificación", "bonificacion"],
    openApiPatterns: [/^\/salary\/transaction/i, /^\/employee/i],
    sandboxKeywords: ["salary transaction", "payroll", "bonus"],
  },
  {
    id: "customer_create",
    label: "Customer Creation",
    priority: "medium",
    nextAction:
      "Keep customer master-data handling strict on organization number, address, postal code, city, and email. Use this family for plain customer create/update prompts instead of leaving them in unknown.",
    canaryNeeded: false,
    keywords: ["customer", "kunde", "client", "cliente", "organisation", "organisasjonsnummer", "organization number"],
    openApiPatterns: [/^\/customer/i],
    sandboxKeywords: ["customer", "postalAddress"],
  },
  {
    id: "product_create",
    label: "Product Creation",
    priority: "low",
    nextAction:
      "Keep product creation deterministic and verify price, cost, VAT, and ledger account on the returned product record.",
    canaryNeeded: false,
    keywords: ["product", "produkt", "producto", "produto", "produit"],
    openApiPatterns: [/^\/product/i, /^\/ledger\/account/i, /vatType/i],
    sandboxKeywords: ["product", "vatType"],
  },
  {
    id: "project_create",
    label: "Project Creation",
    priority: "medium",
    nextAction:
      "Keep project creation focused on exact project name, customer linkage, and specifically requested manager assignment. Use this family for plain project-create prompts instead of treating them as unknown.",
    canaryNeeded: false,
    keywords: ["project", "prosjekt", "proyecto", "projeto", "projekt", "projet"],
    openApiPatterns: [/^\/project/i, /^\/employee/i],
    sandboxKeywords: ["project", "project manager"],
  },
  {
    id: "expense_voucher",
    label: "Expense Voucher From Receipt",
    priority: "high",
    nextAction:
      "Keep receipt-driven expense prompts on voucher creation, preserve department linkage, and enrich them with receipt/item semantics instead of letting them drift into department or generic unknown handling.",
    canaryNeeded: true,
    keywords: ["receipt", "recibo", "kvittering", "expense", "despesa", "utgift", "kostnad", "iva", "mva"],
    openApiPatterns: [/^\/ledger\/voucher/i, /^\/ledger\/account/i, /^\/department/i],
    sandboxKeywords: ["voucher", "receipt", "department"],
  },
  {
    id: "accounting_dimension",
    label: "Accounting Dimension / Free Dimension",
    priority: "medium",
    nextAction:
      "Keep the deterministic accounting-dimension workflow and focus on fresh-account verification gaps. Add prompts that include both dimension creation and tagged voucher posting to the seeded harness corpus.",
    canaryNeeded: false,
    keywords: ["free accounting dimension", "fri regnskapsdimensjon", "custom dimension", "cost center", "kostsenter", "dimension comptable", "dimension compta"],
    openApiPatterns: [/accountingDimensionName/i, /accountingDimensionValue/i, /^\/ledger\/voucher/i],
    sandboxKeywords: ["free dimensions", "accounting dimension", "voucher"],
  },
  {
    id: "returned_payment",
    label: "Returned Payment Reversal",
    priority: "high",
    nextAction:
      "Route returned-payment prompts directly to the voucher-reversal workflow, resolve the original invoice payment voucher deterministically, and verify the reversed voucher plus restored outstanding invoice amount.",
    canaryNeeded: true,
    keywords: ["returned by the bank", "returned payment", "retourné par la banque", "devuelto por el banco", "devolvido pelo banco", "reverse the payment", "annulez le paiement", "reverser betalingen"],
    openApiPatterns: [/\/ledger\/voucher\/.+:reverse/i, /^\/invoice/i, /^\/customer/i],
    sandboxKeywords: ["reverse voucher", "returned payment", "invoice payment"],
  },
  {
    id: "invoice_reminder",
    label: "Invoice Reminder / Reminder Fee",
    priority: "high",
    nextAction:
      "Implement a dedicated reminder workflow around PUT /invoice/{id}/:createReminder, then verify with GET /reminder and invoice outstanding/reminder fields. Promote it into the live canary once implemented.",
    canaryNeeded: true,
    keywords: ["reminder", "taxa de lembrete", "late fee", "reminder fee", "notice of debt collection", "purre", "purring"],
    openApiPatterns: [/createReminder/i, /\/reminder/i],
    sandboxKeywords: ["reminder", "automatic reminders", "soft reminders"],
  },
  {
    id: "project_cycle",
    label: "Composite Project Cycle",
    priority: "high",
    nextAction:
      "Build one composite workflow that chains project creation, participant/manager assignment, hourly rate or budget setup, timesheet entries, and invoice/payment steps as the prompt requires. Use returned IDs between each step and add a dedicated canary.",
    canaryNeeded: true,
    keywords: ["projectzyklus", "project cycle", "vollständigen projektzyklus", "budget", "erfassen sie stunden", "full project cycle", "prosjektsyklus", "prosjektsyklusen", "gjennomfør heile prosjektsyklusen"],
    openApiPatterns: [/^\/project/i, /^\/timesheet\/entry/i, /hourlyRates/i, /invoiceMultipleOrders/i],
    sandboxKeywords: ["project", "budget", "timesheet", "hourly rate"],
  },
  {
    id: "ledger_variance_projects",
    label: "Ledger Variance To Internal Projects",
    priority: "high",
    nextAction:
      "Build a deterministic workflow that reads /ledger/posting for the requested periods, computes the largest increase in expense accounts, and creates one internal project per selected account with returned-ID verification. Add multilingual prompts for this family to the canary corpus once implemented.",
    canaryNeeded: true,
    keywords: [
      "largest increase",
      "kostensteiger",
      "custos totais aumentaram",
      "analise o livro razao",
      "analysieren sie das hauptbuch",
      "deutlich gestiegen",
      "größten anstieg",
      "groessten anstieg",
      "auka monaleg",
      "hovudboka",
      "kostnadskontoane",
      "størst auke",
      "internal project for each",
      "projeto interno para cada",
      "internes projekt fur jedes",
      "internt prosjekt",
    ],
    openApiPatterns: [/^\/ledger\/posting/i, /^\/project/i],
    sandboxKeywords: ["ledger posting", "project", "internal project"],
  },
  {
    id: "ledger_error_correction",
    label: "Ledger Error Review And Correction",
    priority: "high",
    nextAction:
      "Build a voucher-audit workflow that reads vouchers/postings for the target periods, matches the error patterns described in the prompt, then applies reversal or correcting vouchers with exact postcondition verification. This should become its own module rather than falling through to generic voucher logic.",
    canaryNeeded: true,
    keywords: [
      "general ledger",
      "review all vouchers",
      "find the 4 errors",
      "wrong account",
      "duplicate voucher",
      "missing vat",
      "ledger errors",
      "hovedbok",
      "voucher errors",
    ],
    openApiPatterns: [/^\/ledger\/voucher/i, /^\/ledger\/posting/i],
    sandboxKeywords: ["voucher", "ledger posting", "reverse voucher"],
  },
  {
    id: "bank_reconciliation",
    label: "Bank Reconciliation",
    priority: "high",
    nextAction:
      "Keep this behind capability checks. Use the public bank statement import and reconciliation endpoints only when statement, reconciliation settings, and matchable invoices/payments exist. Add prerequisite diagnostics to the failure output.",
    canaryNeeded: true,
    keywords: ["bank", "statement", "csv", "reconcile", "reconciliation", "bankavstemming", "extracto bancario", "kontoauszug"],
    openApiPatterns: [/^\/bank\/statement/i, /^\/bank\/reconciliation/i],
    sandboxKeywords: ["bank reconciliation", "statement", "reconciliation settings"],
  },
  {
    id: "month_end_closing",
    label: "Month-End / Annual Closing",
    priority: "medium",
    nextAction:
      "Keep extending voucher-based close workflows with richer depreciation/accrual parsing and account fallback. The current build should also carry one annual-close probe in the canary set.",
    canaryNeeded: true,
    keywords: ["month-end closing", "year-end", "annual closing", "årsoppgjer", "jahresabschluss", "depreciation", "månedsavslutning", "manedsavslutning", "clôture mensuelle", "cloture mensuelle"],
    openApiPatterns: [/^\/ledger\/voucher/i, /depreciation/i, /^\/asset/i],
    sandboxKeywords: ["depreciation", "year-end", "voucher"],
  },
  {
    id: "attachment_onboarding",
    label: "Document-Driven Employee Onboarding",
    priority: "high",
    nextAction:
      "Build a deterministic onboarding workflow on top of the attachment extraction layer: employee, employment, department, salary, and access template setup verified by returned IDs. Keep PDF/image extraction fail-soft.",
    canaryNeeded: true,
    keywords: ["offer letter", "tilbudsbrev", "onboarding", "new employee", "new hire", "employment contract", "contrat de travail", "contrato de trabalho"],
    openApiPatterns: [/^\/employee/i, /employment/i, /^\/department/i, /^\/salary/i],
    sandboxKeywords: ["employee", "entitlement", "admin", "onboarding"],
  },
  {
    id: "project_time_invoice",
    label: "Project Hours to Invoice",
    priority: "medium",
    nextAction:
      "Keep the existing specialized workflow, but absorb composite project-cycle prompts into it instead of letting them fall into generic project handling.",
    canaryNeeded: false,
    keywords: ["hours", "project invoice", "timesheet", "hourly rate", "fatura de projeto"],
    openApiPatterns: [/^\/project/i, /^\/timesheet\/entry/i, /invoiceMultipleOrders/i],
    sandboxKeywords: ["project", "timesheet"],
  },
  {
    id: "supplier_invoice",
    label: "Supplier Invoice",
    priority: "medium",
    nextAction:
      "Keep the voucher-based supplier invoice workflow and extend it for variants like payment/closing if those prompts appear.",
    canaryNeeded: false,
    keywords: ["supplier invoice", "leverandørfaktura", "fournisseur", "fornecedor"],
    openApiPatterns: [/^\/supplier/i, /^\/ledger\/voucher/i],
    sandboxKeywords: ["supplier", "voucher"],
  },
  {
    id: "invoice_payment",
    label: "Invoice Payment",
    priority: "medium",
    nextAction:
      "Keep the deterministic invoice payment path, but use it as a reusable subworkflow inside reminder and project-cycle tasks instead of treating those prompts as plain pay_invoice.",
    canaryNeeded: false,
    keywords: ["register payment", "open invoice", "betaling", "zahl", "fatura vencida"],
    openApiPatterns: [/\/invoice\/.+:payment/i, /invoicePayment/i, /^\/invoice\/paymentType/i],
    sandboxKeywords: ["invoice", "payment"],
  },
  {
    id: "invoice_create",
    label: "Invoice Creation",
    priority: "low",
    nextAction:
      "Invoice creation is already a stable primitive. Reuse it as a subworkflow in reminder/project-cycle/composite prompts.",
    canaryNeeded: false,
    keywords: ["create invoice", "rechnung", "facture", "fatura"],
    openApiPatterns: [/^\/invoice/i, /invoiceMultipleOrders/i],
    sandboxKeywords: ["invoice"],
  },
  {
    id: "unknown",
    label: "Unknown / New Family",
    priority: "medium",
    nextAction:
      "Capture the prompt preview, cluster it, and promote it into a dedicated workflow or canary if it repeats.",
    canaryNeeded: false,
    keywords: [],
    openApiPatterns: [],
    sandboxKeywords: [],
  },
];

export function detectFamily(text: string): FamilyId {
  const value = text.toLowerCase();
  if (!value) return "unknown";
  if (/(employee|ansatt|arbeidstakar|tilsett|funcion[aá]rio|empregado|empleado|employ[ée]|mitarbeiter)/i.test(value) && /(date of birth|fødselsdato|date de naissance|fecha de nacimiento|data de nascimento|start date|fecha de inicio|data de início|data de inicio|date de début|eintrittsdatum|employment date|tiltredelsesdato|e-mail|email)/i.test(value)) return "employee_create";
  if (/(payroll|salary|lønn|lonn|paie|n[oó]mina|nomina|k[oø]yr l[øo]n)/i.test(value) && /(base salary|salario base|salaire de base|grunnl[øo]n|bonus|bonificaci[oó]n|bonificacion|prime|eingongsbonus)/i.test(value)) return "salary_transaction";
  if (/(customer|kunde|client|cliente)/i.test(value) && /(organization|organisasjonsnummer|organisationsnummer|org\\.?|address|adresse|endere[cç]o|postal|city|e-mail|email)/i.test(value)) return "customer_create";
  if (/(product|produkt|producto|produto|produit)/i.test(value) && /(price|pris|precio|pre[cç]o|vat|mva|iva|tva|number|nummer|nr)/i.test(value)) return "product_create";
  if (/(receipt|recibo|kvittering|kvitteringa|beleg|recu|reçu)/i.test(value) && /(expense|depense|dépense|despesa|utgift|kostnad|iva|mva|vat|tva|department|avdeling|departamento|abteilung|departement|d[ée]partement)/i.test(value)) return "expense_voucher";
  if (/(free accounting dimension|fri regnskapsdimensjon|custom accounting dimension|custom dimension|buchhaltungsdimension|benutzerdefinierte buchhaltungsdimension|cost center|kostsenter|dimension comptable|dimension compta)/i.test(value)) return "accounting_dimension";
  if (/(returned by the bank|returned payment|retourné par la banque|devuelto por el banco|devolvido pelo banco|reverse the payment|annulez le paiement|reverser betalingen|zur[üu]ckgebucht|stornieren sie die zahlung)/i.test(value)) return "returned_payment";
  if (/(reminder|taxa de lembrete|late fee|reminder fee|notice of debt collection|purre|purring)/i.test(value)) return "invoice_reminder";
  if (/(bank|statement|csv|reconciliation|bankavstemming|extracto bancario|kontoauszug|pagos entrantes|eingehende zahlungen|ausgehende zahlungen|lieferantenrechnungen|facturas abiertas|extrato bancario|pagamentos recebidos|pagamentos efetuados)/i.test(value)) return "bank_reconciliation";
  if (/(leverandørfaktura|leverandorfaktura|supplier invoice|facture fournisseur|fatura de fornecedor|fournisseur|fornecedor)/i.test(value)) return "supplier_invoice";
  if (/(projektzyklus|project cycle|vollständigen projektzyklus|full project cycle|prosjektsyklus|prosjektsyklusen|gjennomfor heile prosjektsyklusen|gjennomfør heile prosjektsyklusen|cycle de vie complet du projet|cycle de vie du projet|projet complet)/i.test(value)) return "project_cycle";
  if (/(general ledger|review all vouchers|find the 4 errors|find dei 4 feila|wrong account|duplicate voucher|missing vat|ledger errors|voucher errors|feil i hovudboka|rett opp feila|duplikat bilag|manglande mva|fehler im hauptbuch|überprüfen sie alle belege|uberprufen sie alle belege|finden sie die 4 fehler|korrigieren sie|falsches konto|doppelter beleg|fehlende mwst|fehlende ust)/i.test(value)) return "ledger_error_correction";
  if (/(largest increase|kostensteiger|custos totais aumentaram|costos totales aumentaron|analise o livro razao|analice el libro mayor|libro mayor|cuentas? de gastos|incremento en monto|analysieren sie das hauptbuch|deutlich gestiegen|größten anstieg|groessten anstieg|auka monaleg|kostnadskontoane|størst auke|internal project for each|projeto interno para cada|proyecto interno para cada|internes projekt fur jedes|internt prosjekt)/i.test(value)) return "ledger_variance_projects";
  if (/(year-end|annual closing|month-end closing|jahresabschluss|årsoppgjer|årsoppgjør|månedsavslutning|manedsavslutning|depreciation|encerramento mensal|encerramento anual|fechamento mensal|fechamento anual|depreciação|acréscimos|provisão salarial|clôture mensuelle|cloture mensuelle)/i.test(value)) return "month_end_closing";
  if (/(offer letter|tilbudsbrev|onboarding|new employee|new hire|employment contract|contrat de travail|contrato de trabalho|nouvel employ[ée]|nuevo empleado|novo empregado)/i.test(value)) return "attachment_onboarding";
  if (/(project invoice|timesheet|hourly rate|fatura de projeto)/i.test(value)) return "project_time_invoice";
  if (/(project|prosjekt|proyecto|projeto|projekt|projet)/i.test(value) && /(project manager|prosjektleder|prosjektleiar|projektleiter|chef de projet|org\\.?-?nr|org\\.?nr|customer|kunde|client|cliente)/i.test(value) && !/(hours?|timer|timar|timesheet|budget|project cycle|prosjektsyklus|invoice|faktura|facture|rechnung|fatura)/i.test(value)) return "project_create";
  if (/(register.*payment|zahlung|betal|open invoice|fatura vencida|converta o pedido em fatura|registre o pagamento total|convert.*order.*invoice.*payment|convierte el pedido en factura|conviertalo en factura|conviértalo en factura|registra el pago completo|registre el pago completo)/i.test(value)) return "invoice_payment";
  if (/(year-end|annual closing|month-end closing|jahresabschluss|rechnungsabgrenzung|abschreibungskosten|årsoppgjer|årsoppgjør|månedsavslutning|manedsavslutning|depreciation|encerramento mensal|encerramento anual|fechamento mensal|fechamento anual|depreciação|acréscimos|provisão salarial|clôture mensuelle|cloture mensuelle)/i.test(value)) return "month_end_closing";
  if (/(rechnung|facture|fatura|invoice)/i.test(value)) return "invoice_create";
  return "unknown";
}

export function familyInfo(id: FamilyId): FamilyInsight {
  return FAMILY_INSIGHTS.find((item) => item.id === id) ?? FAMILY_INSIGHTS[FAMILY_INSIGHTS.length - 1]!;
}
