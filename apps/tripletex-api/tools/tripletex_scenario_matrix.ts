import type { TaskEntity, TaskOperation } from "../api/_lib/task_spec.ts";
import type { FamilyId } from "./tripletex_feedback/types.ts";

export type ScenarioLocale = "en" | "no" | "nn" | "de" | "fr" | "es" | "pt";
export type ScenarioMode = "routing" | "attachment" | "stateful";
export type ScenarioSource = "docs" | "live" | "sandbox" | "feedback";

export type TripletexScenario = {
  id: string;
  family: FamilyId;
  locale: ScenarioLocale;
  mode: ScenarioMode;
  source: ScenarioSource;
  prompt: string;
  attachmentFacts?: string[];
  expected: {
    entity: TaskEntity;
    operation: TaskOperation;
  };
  liveCandidate: boolean;
  notes?: string;
};

function scenario(def: TripletexScenario): TripletexScenario {
  return def;
}

export const TRIPLETEX_SCENARIO_MATRIX: TripletexScenario[] = [
  scenario({
    id: "customer-master-data-pt",
    family: "customer_create",
    locale: "pt",
    mode: "routing",
    source: "live",
    prompt:
      "Crie o cliente Aurora Drift AS com e-mail kontakt@auroradrift.no, e-mail de fatura fatura@auroradrift.no, org. nº 914774621, endereço Karl Johans gate 1, código postal 0154, cidade Oslo.",
    expected: { entity: "customer", operation: "create" },
    liveCandidate: true,
    notes: "Customer master-data prompts are still occasionally misbucketed as unknown in feedback.",
  }),
  scenario({
    id: "customer-master-data-fr",
    family: "customer_create",
    locale: "fr",
    mode: "routing",
    source: "live",
    prompt:
      "Créez le client Montagne SARL avec le numéro d'organisation 931564153. L'adresse est Kirkegata 19, 4611 Kristiansand. E-mail : post@montagne.no.",
    expected: { entity: "customer", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "supplier-master-data-es",
    family: "unknown",
    locale: "es",
    mode: "routing",
    source: "live",
    prompt:
      "Registre el proveedor Costa Brava SL con número de organización 947031922, correo facturas@costabrava.es, dirección Calle Mayor 14, código postal 28013 y ciudad Oslo.",
    expected: { entity: "supplier", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "employee-create-fr",
    family: "employee_create",
    locale: "fr",
    mode: "routing",
    source: "live",
    prompt:
      "Créez un employé nommé Léa Thomas, né le 30. June 2000, avec l'e-mail lea.thomas@example.org et la date de début 8. October 2026.",
    expected: { entity: "employee", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "employee-create-pt",
    family: "employee_create",
    locale: "pt",
    mode: "routing",
    source: "live",
    prompt:
      "Temos um novo funcionário chamado Rita Almeida, nascida em 1995-12-29, com o e-mail rita.almeida@example.org e data de início 2026-06-07.",
    expected: { entity: "employee", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "employee-create-pt-maria",
    family: "employee_create",
    locale: "pt",
    mode: "routing",
    source: "live",
    prompt:
      "Temos um novo funcionário chamado Maria Costa, nascido em 21. July 1990. Crie-o como funcionário com o e-mail maria.costa@example.org e data de início 6. January 2026.",
    expected: { entity: "employee", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "employee-create-pt-andre",
    family: "employee_create",
    locale: "pt",
    mode: "routing",
    source: "live",
    prompt:
      "Temos um novo funcionário chamado André Ferreira, nascido em 20. July 1992. Crie-o como funcionário com o e-mail andre.ferreira@example.org e data de início 2. August 2026.",
    expected: { entity: "employee", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "project-create-no-customer-manager",
    family: "project_create",
    locale: "no",
    mode: "routing",
    source: "live",
    prompt:
      'Opprett prosjektet "Migrasjon Vestfjord" knytt til kunden Vestfjord AS (org.nr 887727872). Prosjektleiar er Liv Stølsvik (liv.stlsvik@example.org).',
    expected: { entity: "project", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "project-create-de-customer-manager",
    family: "project_create",
    locale: "de",
    mode: "routing",
    source: "live",
    prompt:
      'Erstellen Sie das Projekt "Integration Windkraft" verknüpft mit dem Kunden Windkraft GmbH (Org.-Nr. 804172807). Projektleiter ist Hannah Weber (hannah.weber@example.org).',
    expected: { entity: "project", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "attachment-onboarding-no",
    family: "attachment_onboarding",
    locale: "no",
    mode: "attachment",
    source: "live",
    prompt: "Du har mottatt et tilbudsbrev i vedlagt dokument. Utfør komplett onboarding for den nye ansatte med brukeradgang.",
    attachmentFacts: [
      "Employee: Lea Nordmann",
      "Email: lea.nordmann@example.org",
      "Date of birth: 2000-06-12",
      "National identity number: 12060012345",
      "Start date: 2026-10-08",
      "Department: Salg",
      "Occupation code: 2512",
      "Employment percentage: 80 %",
      "Annual salary: 720000 NOK",
      "User access: standard user",
    ],
    expected: { entity: "attachment_onboarding", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "attachment-onboarding-fr",
    family: "attachment_onboarding",
    locale: "fr",
    mode: "attachment",
    source: "live",
    prompt: "Vous avez recu une lettre d'offre (voir PDF ci-joint) pour un nouvel employe. Effectuez l'integration complete avec acces utilisateur.",
    attachmentFacts: [
      "Nom: Jean Dupont",
      "E-mail: jean.dupont@example.org",
      "Date de naissance: 1989-04-12",
      "Numero d'identite: 12048912345",
      "Date de debut: 2026-04-01",
      "Departement: Conseil",
      "Code profession: 2130",
      "Pourcentage d'emploi: 100 %",
      "Salaire annuel: 720000 NOK",
      "Compte bancaire: 15038844556",
      "Acces utilisateur: utilisateur standard",
    ],
    expected: { entity: "attachment_onboarding", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "attachment-onboarding-es",
    family: "attachment_onboarding",
    locale: "es",
    mode: "attachment",
    source: "live",
    prompt: "Has recibido una carta de oferta (ver PDF adjunto) para un nuevo empleado. Completa la incorporacion: crea el empleado, asigna el departamento correcto, configura los detalles de empleo con porcentaje y salario anual, y concede acceso de usuario.",
    attachmentFacts: [
      "Empleado: Diego Flores",
      "Correo: diego.flores@example.org",
      "Fecha de nacimiento: 1994-05-21",
      "Fecha de inicio: 2026-10-15",
      "Departamento: Operaciones",
      "Codigo ocupacion: 4110",
      "Porcentaje de empleo: 75 %",
      "Salario anual: 690000 NOK",
      "Acceso de usuario: standard user",
    ],
    expected: { entity: "attachment_onboarding", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "department-batch-de",
    family: "unknown",
    locale: "de",
    mode: "routing",
    source: "docs",
    prompt: 'Erstellen Sie drei Abteilungen in Tripletex: "Nord", "Süd" und "West".',
    expected: { entity: "department", operation: "create" },
    liveCandidate: false,
  }),
  scenario({
    id: "department-batch-pt",
    family: "unknown",
    locale: "pt",
    mode: "routing",
    source: "live",
    prompt: 'Crie três departamentos no Tripletex: "Drift", "Kundeservice" e "HR".',
    expected: { entity: "department", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "product-create-no",
    family: "product_create",
    locale: "no",
    mode: "routing",
    source: "docs",
    prompt: "Opprett produktet Konsulenttimer med nummer 5511, pris 1450 NOK og MVA 25 %.",
    expected: { entity: "product", operation: "create" },
    liveCandidate: false,
  }),
  scenario({
    id: "product-create-en",
    family: "product_create",
    locale: "en",
    mode: "routing",
    source: "feedback",
    prompt: "Create the product System Development with number 5511, price 28500 NOK excluding VAT, cost 12000 NOK, and VAT 25%.",
    expected: { entity: "product", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "product-create-fr",
    family: "product_create",
    locale: "fr",
    mode: "routing",
    source: "feedback",
    prompt: "Créez le produit Développement système avec le numéro 5511, un prix de 28500 NOK hors TVA, un coût de 12000 NOK et une TVA de 25 %.",
    expected: { entity: "product", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "product-create-pt-account",
    family: "product_create",
    locale: "pt",
    mode: "routing",
    source: "feedback",
    prompt: "Crie o produto Desenvolvimento de Sistemas com número 5511, preço 28500 NOK sem IVA, custo 12000 NOK e conta 3400.",
    expected: { entity: "product", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "invoice-create-send-en",
    family: "invoice_create",
    locale: "en",
    mode: "routing",
    source: "live",
    prompt:
      "Create and send an invoice to the customer Ironbridge Ltd (org no. 841254546) for 28500 NOK excluding VAT. The invoice is for System Development.",
    expected: { entity: "invoice", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "invoice-create-send-fr",
    family: "invoice_create",
    locale: "fr",
    mode: "routing",
    source: "docs",
    prompt:
      "Créez et envoyez une facture au client Ridgepoint Ltd (org no. 941587437) pour 40400 NOK hors TVA. La facture concerne Maintenance.",
    expected: { entity: "invoice", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "invoice-payment-fx-nn",
    family: "invoice_payment",
    locale: "nn",
    mode: "stateful",
    source: "live",
    prompt:
      'Me sende ein faktura på 10143 EUR til Fjelltopp AS (org.nr. 954884791) for tenesta "Skytjenester". Kursen ved utsending var 10.54. Kunden har no betalt fakturaen til kurs 10.23. Registrer betalinga og bokfør valutadifferansen på rett konto.',
    expected: { entity: "invoice", operation: "pay_invoice" },
    liveCandidate: true,
  }),
  scenario({
    id: "invoice-payment-composite-es",
    family: "invoice_payment",
    locale: "es",
    mode: "stateful",
    source: "live",
    prompt:
      "Cree un pedido para Solmar Lda (org. nº 954808483), conviértalo en factura y registre el pago completo.",
    expected: { entity: "invoice", operation: "pay_invoice" },
    liveCandidate: true,
  }),
  scenario({
    id: "invoice-reminder-no",
    family: "invoice_reminder",
    locale: "no",
    mode: "stateful",
    source: "live",
    prompt:
      "En av kundene dine, Nordlys AS (org.nr 954884791), har en forfalt faktura på 1000 NOK. Finn den forfalte fakturaen, bokfør et purregebyr på 50 kr, opprett også en faktura for purregebyret til kunden og send den.",
    expected: { entity: "invoice_reminder", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "returned-payment-pt",
    family: "returned_payment",
    locale: "pt",
    mode: "stateful",
    source: "live",
    prompt:
      "O pagamento da fatura 10234 foi devolvido pelo banco. Reverta o pagamento e restaure o valor em aberto na fatura.",
    expected: { entity: "voucher", operation: "reverse_voucher" },
    liveCandidate: true,
  }),
  scenario({
    id: "returned-payment-de",
    family: "returned_payment",
    locale: "de",
    mode: "stateful",
    source: "live",
    prompt:
      'Die Zahlung von Brückentor GmbH (Org.-Nr. 944848479) für die Rechnung "Wartung" (42200 NOK ohne MwSt.) wurde von der Bank zurückgebucht. Stornieren Sie die Zahlung, damit die Rechnung wieder den offenen Betrag anzeigt.',
    expected: { entity: "voucher", operation: "reverse_voucher" },
    liveCandidate: true,
  }),
  scenario({
    id: "returned-payment-es",
    family: "returned_payment",
    locale: "es",
    mode: "stateful",
    source: "live",
    prompt:
      'El pago de Sierra SL (org. nº 910318144) por la factura "Almacenamiento en la nube" (19250 NOK sin IVA) fue devuelto por el banco. Revierta el pago para que la factura vuelva a mostrar el importe pendiente.',
    expected: { entity: "voucher", operation: "reverse_voucher" },
    liveCandidate: true,
  }),
  scenario({
    id: "supplier-invoice-no",
    family: "supplier_invoice",
    locale: "no",
    mode: "stateful",
    source: "live",
    prompt:
      "Vi har mottatt faktura INV-2026-8551 fra leverandøren Solmar Lda (org.nr 954808483) på 62600 NOK inkludert MVA. Beløpet gjelder juridiske tjenester på konto 6860. Registrer leverandørfakturaen med korrekt inngående MVA 25 %.",
    expected: { entity: "supplier_invoice", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "supplier-invoice-pt-live",
    family: "supplier_invoice",
    locale: "pt",
    mode: "stateful",
    source: "live",
    prompt:
      "Recebemos a fatura INV-2026-7230 do fornecedor Solmar Lda (org. nº 973188410) no valor de 7700 NOK com IVA incluído. O montante refere-se a serviços de escritório (conta 7140). Registe a fatura do fornecedor com o IVA de 25 %.",
    expected: { entity: "supplier_invoice", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "attachment-supplier-invoice-no",
    family: "supplier_invoice",
    locale: "no",
    mode: "attachment",
    source: "live",
    prompt:
      "Du har mottatt en leverandørfaktura i vedlagt dokument. Registrer fakturaen i Tripletex. Opprett leverandøren hvis den ikke finnes. Bruk riktig utgiftskonto og inngående MVA.",
    attachmentFacts: [
      "Fakturanummer: INV-2026-4647",
      "Leverandør: Cascade SARL",
      "Organisasjonsnummer: 947031922",
      "Beløp inkl. MVA: 14850 NOK",
      "Utgiftskonto: 6300",
      "MVA: 25 %",
      "Beskrivelse: Kontortjenester",
    ],
    expected: { entity: "supplier_invoice", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "attachment-supplier-invoice-no-ascii",
    family: "supplier_invoice",
    locale: "no",
    mode: "attachment",
    source: "feedback",
    prompt:
      "Du har mottatt en leverandorfaktura (se vedlagt PDF). Registrer fakturaen i Tripletex. Opprett leverandoren hvis den ikke finnes. Bruk riktig utgiftskonto og inngaende MVA.",
    attachmentFacts: [
      "Fakturanummer: INV-2026-4647",
      "Leverandor: Cascade SARL",
      "Organisasjonsnummer: 947031922",
      "Belop inkl. MVA: 14850 NOK",
      "Utgiftskonto: 6300",
      "Inngaende MVA: 25 %",
      "Beskrivelse: Kontortjenester",
    ],
    expected: { entity: "supplier_invoice", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "travel-expense-es",
    family: "unknown",
    locale: "es",
    mode: "routing",
    source: "docs",
    prompt:
      "Cree un gasto de viaje para Sofia Nilsen (sofia.nilsen@example.org) con fecha 2026-03-19, tarifa diaria de 950 NOK por 2 días, y añada los costes Hotel 1800 NOK y Taxi 420 NOK.",
    expected: { entity: "travel_expense", operation: "create" },
    liveCandidate: false,
  }),
  scenario({
    id: "travel-expense-no-ragnhild",
    family: "unknown",
    locale: "no",
    mode: "routing",
    source: "live",
    prompt:
      'Registrer en reiseregning for Ragnhild Bakken (ragnhild.bakken@example.org) for "Kundebesøk Kristiansand". Reisen varte 4 dager med diett (dagsats 800 kr). Utlegg: flybillett 5450 kr og taxi 550 kr.',
    expected: { entity: "travel_expense", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "receipt-expense-pt",
    family: "expense_voucher",
    locale: "pt",
    mode: "attachment",
    source: "live",
    prompt:
      "Precisamos da despesa de Kaffemøte deste recibo registada no departamento Utvikling. Use a conta de despesas correta e garanta o tratamento correto do IVA.",
    attachmentFacts: [
      "Description: Kaffemøte",
      "Date: 2026-03-18",
      "Amount incl. VAT: 1 250 NOK",
      "Expense account: 7350",
      "VAT: 25 %",
      "Department: Utvikling",
    ],
    expected: { entity: "voucher", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "receipt-expense-pt-overnatting",
    family: "expense_voucher",
    locale: "pt",
    mode: "attachment",
    source: "live",
    prompt:
      "Precisamos da despesa de Overnatting deste recibo registada no departamento Utvikling. Use a conta de despesas correta e garanta o tratamento correto do IVA.",
    attachmentFacts: [
      "Description: Overnatting",
      "Date: 2026-03-22",
      "Amount incl. VAT: 4 200 NOK",
      "VAT: 12 %",
      "Department: Utvikling",
    ],
    expected: { entity: "voucher", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "receipt-expense-pt-overnatting-eu-amount",
    family: "expense_voucher",
    locale: "pt",
    mode: "attachment",
    source: "synthetic",
    prompt:
      "Precisamos da despesa de Overnatting deste recibo registada no departamento Utvikling. Use a conta de despesas correta e garanta o tratamento correto do IVA.",
    attachmentFacts: [
      "Description: Overnatting",
      "Date: 2026-03-22",
      "Amount incl. VAT: 4.200,00 NOK",
      "VAT: 12 %",
      "Department: Utvikling",
    ],
    expected: { entity: "voucher", operation: "create" },
    liveCandidate: false,
  }),
  scenario({
    id: "receipt-expense-fr",
    family: "expense_voucher",
    locale: "fr",
    mode: "attachment",
    source: "live",
    prompt:
      "Nous avons besoin de la depense Skrivebordlampe de ce recu enregistree au departement Produksjon. Utilisez le bon compte de charges et assurez le traitement correct de la TVA.",
    attachmentFacts: [
      "Description: Skrivebordlampe",
      "Date: 2026-03-18",
      "Montant TTC: 1 250 NOK",
      "Compte de charges: 6550",
      "TVA: 25 %",
      "Departement: Produksjon",
    ],
    expected: { entity: "voucher", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "payroll-bonus-nn",
    family: "salary_transaction",
    locale: "nn",
    mode: "stateful",
    source: "live",
    prompt:
      "Køyr løn for Brita Stølsvik (brita.stolsvik@example.org) for denne månaden. Grunnløna er 56950 NOK. Legg til ein eingongsbonus på 9350 NOK i tillegg til grunnløna.",
    expected: { entity: "salary_transaction", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "payroll-bonus-nn-brita-berge",
    family: "salary_transaction",
    locale: "nn",
    mode: "stateful",
    source: "feedback",
    prompt:
      "Køyr løn for Brita Berge (brita.berge@example.org) for denne månaden. Grunnløn er 36800 kr. Legg til ein eingongsbonus på 14100 kr i tillegg til grunnløna.",
    expected: { entity: "salary_transaction", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "payroll-bonus-es",
    family: "salary_transaction",
    locale: "es",
    mode: "stateful",
    source: "live",
    prompt:
      "Ejecute la nómina de Fernando López (fernando.lopez@example.org) para este mes. El salario base es de 37850 NOK. Añada una bonificación única de 9200 NOK además del salario base.",
    expected: { entity: "salary_transaction", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "payroll-bonus-fr-chloe-dubois",
    family: "salary_transaction",
    locale: "fr",
    mode: "stateful",
    source: "feedback",
    prompt:
      "Exécutez la paie de Chloé Dubois (chloe.dubois@example.org) pour ce mois. Le salaire de base est de 58350 NOK. Ajoutez une prime unique de 9300 NOK en plus du salaire de base.",
    expected: { entity: "salary_transaction", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "project-time-invoice-pt",
    family: "project_time_invoice",
    locale: "pt",
    mode: "stateful",
    source: "docs",
    prompt:
      'Registe 4 horas para Maria Nilsen (maria.nilsen@example.org) na atividade "Desenvolvimento" do projeto "Canary App" para Aurora Drift AS (org. nº 914774621). Taxa horária: 1050 NOK/h. Gere uma fatura de projeto ao cliente.',
    expected: { entity: "invoice", operation: "create" },
    liveCandidate: false,
  }),
  scenario({
    id: "project-time-invoice-en",
    family: "project_time_invoice",
    locale: "en",
    mode: "stateful",
    source: "feedback",
    prompt:
      'Log 34 hours for Charlotte Williams (charlotte.williams@example.org) on the activity "Analyse" in the project "Security Audit" for Windmill Ltd (org no. 851492623). Hourly rate: 1300 NOK/h. Generate a project invoice to the customer.',
    expected: { entity: "invoice", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "project-cycle-fr",
    family: "project_cycle",
    locale: "fr",
    mode: "stateful",
    source: "live",
    prompt:
      'Réalisez le cycle de vie complet du projet "Dataplattform Elvdal" pour le client Fjordkraft AS (org no. 954808483): créez le projet, définissez un budget de 250000 NOK, enregistrez 14 heures de travail pour Emma Larsen et facturez ensuite le client.',
    expected: { entity: "project_cycle", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "project-cycle-no",
    family: "project_cycle",
    locale: "no",
    mode: "stateful",
    source: "feedback",
    prompt:
      'Gjennomfør hele prosjektsyklusen for prosjektet "Dataplattform Elvdal" for kunden Fjordkraft AS (org.nr 954808483): opprett prosjektet, legg inn budsjett på 250000 NOK, registrer 14 timer for Emma Larsen og fakturer kunden.',
    expected: { entity: "project_cycle", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "month-end-pt",
    family: "month_end_closing",
    locale: "pt",
    mode: "stateful",
    source: "live",
    prompt:
      "Faça o encerramento mensal de março de 2026. Reverta a provisão salarial de 45000 NOK da conta 2960 para a conta 5000 e registe a depreciação mensal de 5000 NOK durante 5 anos.",
    expected: { entity: "month_end_closing", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "month-end-de",
    family: "month_end_closing",
    locale: "de",
    mode: "stateful",
    source: "live",
    prompt:
      "Führen Sie den Monatsabschluss für März 2026 durch. Buchen Sie eine Rechnungsabgrenzung von 45000 NOK von Konto 2960 auf Konto 5000 zurück und erfassen Sie monatliche Abschreibungskosten von 5000 NOK über 5 Jahre.",
    expected: { entity: "month_end_closing", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "bank-reconciliation-en",
    family: "bank_reconciliation",
    locale: "en",
    mode: "stateful",
    source: "docs",
    prompt:
      "Import the attached CSV bank statement, reconcile the incoming payment to the matching open invoice, and mark the remaining unmatched row for manual follow-up.",
    expected: { entity: "bank_reconciliation", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "bank-reconciliation-es",
    family: "bank_reconciliation",
    locale: "es",
    mode: "stateful",
    source: "live",
    prompt:
      "Concilia el extracto bancario (CSV adjunto) con las facturas abiertas en Tripletex. Relaciona los pagos entrantes con las facturas de clientes y los pagos salientes con las facturas de proveedores. Maneja los pagos parciales correctamente y deja la fila no conciliada para seguimiento manual.",
    expected: { entity: "bank_reconciliation", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "bank-reconciliation-de",
    family: "bank_reconciliation",
    locale: "de",
    mode: "stateful",
    source: "live",
    prompt:
      "Gleichen Sie den Kontoauszug (beigefuegte CSV) mit den offenen Rechnungen in Tripletex ab. Ordnen Sie eingehende Zahlungen Kundenrechnungen und ausgehende Zahlungen Lieferantenrechnungen zu. Behandeln Sie Teilzahlungen korrekt und lassen Sie die nicht zugeordnete Zeile zur manuellen Nachverfolgung offen.",
    expected: { entity: "bank_reconciliation", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "bank-reconciliation-fr",
    family: "bank_reconciliation",
    locale: "fr",
    mode: "stateful",
    source: "live",
    prompt:
      "Rapprochez le relevé bancaire (CSV ci-joint) avec les factures ouvertes dans Tripletex. Associez les paiements entrants aux factures clients et les paiements sortants aux factures fournisseurs. Gérez correctement les paiements partiels et laissez la ligne non rapprochée pour suivi manuel.",
    expected: { entity: "bank_reconciliation", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "ledger-variance-de",
    family: "ledger_variance_projects",
    locale: "de",
    mode: "stateful",
    source: "live",
    prompt:
      "Die Gesamtkosten sind von Februar auf März 2026 deutlich gestiegen. Finden Sie die 3 Aufwandskonten mit dem größten Anstieg und erstellen Sie für jedes ein internes Projekt.",
    expected: { entity: "ledger_variance_projects", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "ledger-variance-es-live",
    family: "ledger_variance_projects",
    locale: "es",
    mode: "stateful",
    source: "feedback",
    prompt:
      "Los costos totales aumentaron significativamente de enero a febrero de 2026. Analice el libro mayor e identifique las tres cuentas de gastos con el mayor incremento en monto. Cree un proyecto interno para cada una de las cuentas seleccionadas.",
    expected: { entity: "ledger_variance_projects", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "ledger-error-correction-en",
    family: "ledger_error_correction",
    locale: "en",
    mode: "stateful",
    source: "live",
    prompt:
      "We have discovered errors in the general ledger for January and February 2026. Review all vouchers, find the 2 errors, and correct them. Log every change as audit note.",
    expected: { entity: "ledger_error_correction", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "ledger-error-correction-nn",
    family: "ledger_error_correction",
    locale: "nn",
    mode: "stateful",
    source: "live",
    prompt:
      "Me har oppdaga feil i hovudboka for januar og februar 2026. Gå gjennom alle bilag og finn dei 4 feila: ei postering på feil konto, eit duplikat bilag og ein transaksjon med manglande MVA. Rett opp feila og loggfør endringane.",
    expected: { entity: "ledger_error_correction", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "ledger-error-correction-de",
    family: "ledger_error_correction",
    locale: "de",
    mode: "stateful",
    source: "live",
    prompt:
      "Wir haben Fehler im Hauptbuch für Januar und Februar 2026 entdeckt. Überprüfen Sie alle Belege und finden Sie die 4 Fehler: eine Buchung auf das falsche Konto, ein doppelter Beleg und eine Transaktion mit fehlender MwSt. Korrigieren Sie die Fehler und protokollieren Sie jede Änderung.",
    expected: { entity: "ledger_error_correction", operation: "create" },
    liveCandidate: true,
  }),
  scenario({
    id: "accounting-dimension-fr",
    family: "accounting_dimension",
    locale: "fr",
    mode: "stateful",
    source: "docs",
    prompt:
      'Créez une dimension comptable libre nommée "Canal commercial" avec les valeurs "B2B" et "B2C", puis enregistrez un voucher étiqueté avec la valeur B2B.',
    expected: { entity: "accounting_dimension", operation: "create" },
    liveCandidate: false,
  }),
];

export function listLiveCandidateScenarios(): TripletexScenario[] {
  return TRIPLETEX_SCENARIO_MATRIX.filter((scenario) => scenario.liveCandidate);
}

export function summarizeScenarioMatrix() {
  const byFamily = new Map<FamilyId, number>();
  const byLocale = new Map<ScenarioLocale, number>();
  const byMode = new Map<ScenarioMode, number>();
  for (const scenario of TRIPLETEX_SCENARIO_MATRIX) {
    byFamily.set(scenario.family, (byFamily.get(scenario.family) ?? 0) + 1);
    byLocale.set(scenario.locale, (byLocale.get(scenario.locale) ?? 0) + 1);
    byMode.set(scenario.mode, (byMode.get(scenario.mode) ?? 0) + 1);
  }
  return {
    total: TRIPLETEX_SCENARIO_MATRIX.length,
    liveCandidates: TRIPLETEX_SCENARIO_MATRIX.filter((scenario) => scenario.liveCandidate).length,
    byFamily: Object.fromEntries([...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    byLocale: Object.fromEntries([...byLocale.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    byMode: Object.fromEntries([...byMode.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}
