import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

type TripletexCredentials = {
  base_url: string;
  session_token: string;
};

type CanaryCase = {
  name: string;
  prompt: string;
  expectedVerified?: boolean;
  files?: Array<{
    filename: string;
    mime_type: string;
    content_base64: string;
  }>;
};

type CanaryResult = {
  name: string;
  ok: boolean;
  status: number;
  verified: boolean;
  runId: string;
  durationMs: number;
  statusText?: string;
  bodyPreview: string;
};

function parseFlag(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function localIsoDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function uniqueSuffix(): string {
  return `${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(2, 5)}`;
}

function makeOrgNumber(seed: number): string {
  const base = 900_000_000 + (seed % 99_999_999);
  return String(base).slice(0, 9);
}

async function readAccountFile(accountPath: string): Promise<TripletexCredentials> {
  const raw = await fs.readFile(accountPath, "utf8");
  const baseUrl = raw.match(/^API URL\s*\n([^\n]+)\s*$/m)?.[1]?.trim();
  const sessionToken = raw.match(/^Session token\s*\n([^\n]+)\s*$/m)?.[1]?.trim();
  assert(baseUrl, `Could not parse API URL from ${accountPath}`);
  assert(sessionToken, `Could not parse session token from ${accountPath}`);
  return {
    base_url: baseUrl,
    session_token: sessionToken,
  };
}

async function resolveTripletexCredentials(): Promise<TripletexCredentials> {
  const baseUrl = process.env.TRIPLETEX_BASE_URL?.trim();
  const sessionToken = process.env.TRIPLETEX_SESSION_TOKEN?.trim();
  if (baseUrl && sessionToken) {
    return { base_url: baseUrl, session_token: sessionToken };
  }
  const repoRoot = process.cwd();
  const accountPath = path.join(repoRoot, "tripletex", "local", "account.txt");
  return readAccountFile(accountPath);
}

function buildCases(seed: string): CanaryCase[] {
  const today = localIsoDate();
  const orgNumber = makeOrgNumber(Number(seed.slice(0, 6)));
  const customerName = `Canary ${seed} AS`;
  const customerEmail = `canary.customer.${seed}@example.org`;
  const customerInvoiceEmail = `canary.invoice.${seed}@example.org`;
  const travelEmployee = `Sofia Canary ${seed}`;
  const travelEmail = `canary.travel.${seed}@example.org`;
  const employeeName = `Lea Canary ${seed}`;
  const employeeEmail = `canary.employee.${seed}@example.org`;
  const payrollEmployee = `Jules Canary ${seed}`;
  const payrollEmail = `canary.payroll.${seed}@example.org`;
  const projectEmployee = `Maria Canary ${seed}`;
  const projectEmail = `canary.project.${seed}@example.org`;
  const onboardingEmployee = `Lea Canary ${seed}`;
  const onboardingEmail = `canary.onboarding.${seed}@example.org`;
  const departmentA = `CanaryDept-${seed}-A`;
  const departmentB = `CanaryDept-${seed}-B`;
  const departmentC = `CanaryDept-${seed}-C`;
  const projectName = `Canary App ${seed}`;
  const activityName = `Utvikling ${seed}`;
  const productOne = `91${seed.slice(0, 4)}`;
  const productTwo = `92${seed.slice(0, 4)}`;
  const reminderCustomerName = `Reminder Canary ${seed} AS`;
  const reminderOrgNumber = makeOrgNumber(Number(seed.slice(0, 6)) + 77_000);
  const supplierName = `Canary Supplier ${seed} AS`;
  const supplierOrgNumber = makeOrgNumber(Number(seed.slice(0, 6)) + 111);
  const supplierInvoiceNumber = `CAN-SUP-${seed}`;

  return [
    {
      name: "customer_master_data",
      prompt: `Crie o cliente ${customerName} com e-mail ${customerEmail}, e-mail de fatura ${customerInvoiceEmail}, org. nº ${orgNumber}, endereço Karl Johans gate 1, código postal 0154, cidade Oslo.`,
      expectedVerified: true,
    },
    {
      name: "department_batch",
      prompt: `Erstellen Sie drei Abteilungen in Tripletex: "${departmentA}", "${departmentB}" und "${departmentC}".`,
      expectedVerified: true,
    },
    {
      name: "employee_create",
      prompt: `Créez un employé nommé ${employeeName}, né le 30. June 2000, avec l'e-mail ${employeeEmail} et la date de début 8. October 2026.`,
      expectedVerified: true,
    },
    {
      name: "attachment_onboarding",
      prompt: "Du har mottatt et tilbudsbrev i vedlagt dokument. Utfør komplett onboarding for den nye ansatte med brukeradgang.",
      expectedVerified: true,
      files: [
        {
          filename: "offer-letter.txt",
          mime_type: "text/plain",
          content_base64: Buffer.from(
            `Employment contract\nEmployee: ${onboardingEmployee}\nEmail: ${onboardingEmail}\nDate of birth: 2000-06-12\nNational identity number: 12060012345\nStart date: 2026-10-08\nDepartment: Salg\nOccupation code: 2512\nEmployment percentage: 80 %\nAnnual salary: 720000 NOK\nBank account number: 12345678901\nUser access: standard user\n`,
            "utf8",
          ).toString("base64"),
        },
      ],
    },
    {
      name: "invoice_multiline",
      prompt: `Créez une facture pour ${customerName} (org. no. ${orgNumber}) datée du ${today}. Lignes: "Canary Licence ${seed}" (${productOne}) à 1000 NOK avec TVA 25 %, et "Canary Conseil ${seed}" (${productTwo}) à 500 NOK avec TVA 15 %.`,
      expectedVerified: true,
    },
    {
      name: "invoice_payment",
      prompt: `Der Kunde ${customerName} (Org.-Nr. ${orgNumber}) hat eine offene Rechnung über 1500 NOK ohne MwSt. für "Canary Licence ${seed}". Registrieren Sie die vollständige Zahlung dieser Rechnung.`,
      expectedVerified: true,
    },
    {
      name: "invoice_reminder",
      prompt: `En av kundene dine, ${reminderCustomerName} (org.nr ${reminderOrgNumber}), har en forfalt faktura på 1000 NOK. Finn den forfalte fakturaen, bokfør et purregebyr på 50 kr, opprett også en faktura for purregebyret til kunden og send den.`,
      expectedVerified: true,
    },
    {
      name: "travel_expense",
      prompt: `Cree un gasto de viaje para ${travelEmployee} (${travelEmail}) con fecha ${today}, tarifa diaria de 950 NOK por 2 días, y añada los costes Hotel 1800 NOK y Taxi 420 NOK.`,
      expectedVerified: true,
    },
    {
      name: "payroll",
      prompt: `Exécutez la paie de ${payrollEmployee} (${payrollEmail}) pour ce mois. Le salaire de base est de 56950 NOK. Ajoutez une prime unique de 9350 NOK en plus du salaire de base.`,
      expectedVerified: true,
    },
    {
      name: "project_time_invoice",
      prompt: `Registe 4 horas para ${projectEmployee} (${projectEmail}) na atividade "${activityName}" do projeto "${projectName}" para ${customerName} (org. nº ${orgNumber}). Taxa horária: 1050 NOK/h. Gere uma fatura de projeto ao cliente.`,
      expectedVerified: true,
    },
    {
      name: "supplier_invoice",
      prompt: `Vi har mottatt faktura ${supplierInvoiceNumber} fra leverandøren ${supplierName} (org.nr ${supplierOrgNumber}) på 14850 kr inklusiv MVA. Beløpet gjelder kontortjenester (konto 6300). Registrer leverandørfakturaen med korrekt inngående MVA (25 %).`,
      expectedVerified: true,
    },
    {
      name: "attachment_supplier_invoice",
      prompt: "Du har mottatt en leverandorfaktura (se vedlagt PDF). Registrer fakturaen i Tripletex. Opprett leverandoren hvis den ikke finnes. Bruk riktig utgiftskonto og inngående MVA.",
      expectedVerified: true,
      files: [
        {
          filename: "supplier-invoice.txt",
          mime_type: "text/plain",
          content_base64: Buffer.from(
            `Leverandørfaktura\nFakturanummer: ${supplierInvoiceNumber}-DOC\nLeverandør: ${supplierName}\nOrganisasjonsnummer: ${supplierOrgNumber}\nFakturadato: ${today}\nForfallsdato: ${today}\nBeløp inkl. MVA: 14850 NOK\nUtgiftskonto: 6300\nMVA: 25%\nBeskrivelse: Kontortjenester\n`,
            "utf8",
          ).toString("base64"),
        },
      ],
    },
    {
      name: "ledger_variance_projects",
      prompt: "Die Gesamtkosten sind von Februar auf März 2026 deutlich gestiegen. Finden Sie die 3 Aufwandskonten mit dem größten Anstieg und erstellen Sie für jedes ein internes Projekt.",
      expectedVerified: true,
    },
  ];
}

async function runCase(
  endpoint: string,
  creds: TripletexCredentials,
  apiKey: string | undefined,
  canaryCase: CanaryCase,
): Promise<CanaryResult> {
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      prompt: canaryCase.prompt,
      files: canaryCase.files ?? [],
      tripletex_credentials: creds,
    }),
  });

  const bodyText = await response.text();
  const verified = response.headers.get("x-tripletex-verified") === "1";
  const runId = response.headers.get("x-tripletex-run-id") ?? "";
  const ok = response.status === 200 && (canaryCase.expectedVerified === false || verified);
  return {
    name: canaryCase.name,
    ok,
    status: response.status,
    verified,
    runId,
    durationMs: Date.now() - startedAt,
    statusText: response.headers.get("x-tripletex-status") ?? undefined,
    bodyPreview: bodyText.slice(0, 500),
  };
}

function printResult(result: CanaryResult): void {
  const marker = result.ok ? "PASS" : "FAIL";
  const runId = result.runId || "-";
  const verified = result.verified ? "1" : "0";
  console.log(
    `${marker} ${result.name} status=${result.status} verified=${verified} runId=${runId} durationMs=${result.durationMs}${result.statusText ? ` solverStatus=${result.statusText}` : ""}`,
  );
  if (!result.ok) {
    console.log(`  body: ${result.bodyPreview.replace(/\s+/g, " ").trim()}`);
  }
}

async function main(): Promise<void> {
  const endpoint = parseFlag("endpoint") ?? process.env.TRIPLETEX_SOLVE_URL ?? "https://nmiai26-tripletex.vercel.app/solve?debug=1";
  const apiKey = parseFlag("api-key") ?? process.env.TRIPLETEX_API_KEY;
  const creds = await resolveTripletexCredentials();
  const seed = uniqueSuffix();
  const cases = buildCases(seed);

  console.log(`Tripletex live canary against ${endpoint}`);
  console.log(`Seed: ${seed}`);

  const healthUrl = endpoint.replace(/\/solve(?:\?.*)?$/, "/health");
  const healthResponse = await fetch(healthUrl, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!healthResponse.ok) {
    throw new Error(`Health check failed: ${healthResponse.status} ${healthResponse.statusText}`);
  }
  console.log(`Health OK: ${healthUrl}`);

  const results: CanaryResult[] = [];
  for (const canaryCase of cases) {
    const result = await runCase(endpoint, creds, apiKey, canaryCase);
    results.push(result);
    printResult(result);
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(`Summary: ${passed}/${results.length} canary cases passed`);
  if (passed !== results.length) {
    const failedNames = results.filter((result) => !result.ok).map((result) => `${result.name}:${result.runId || "no-run-id"}`);
    throw new Error(`Canary failed: ${failedNames.join(", ")}`);
  }
}

await main();
