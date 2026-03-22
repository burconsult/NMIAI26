import { TripletexClient, TripletexError, primaryValue } from "./tripletex.js";

type CapabilityFlag = boolean | null;

export type TripletexCapabilities = {
  modules: {
    departmentAccounting: CapabilityFlag;
    productAccounting: CapabilityFlag;
    projectAccounting: CapabilityFlag;
    wageProjectAccounting: CapabilityFlag;
    fixedAssetRegister: CapabilityFlag;
  };
  dimensions: {
    freeDimensionSlotsUsed: number | null;
    freeDimensionSlotsAvailable: number | null;
  };
  bank: {
    hasStatements: CapabilityFlag;
    hasReconciliations: CapabilityFlag;
    hasReconciliationSettings: CapabilityFlag;
  };
  assets: {
    featureAvailable: CapabilityFlag;
    hasAssets: CapabilityFlag;
  };
  probeErrors: string[];
};

type SafeProbeResult =
  | { ok: true; response: unknown }
  | { ok: false; statusCode?: number; error: string };

function toValues(response: unknown): Array<Record<string, unknown>> {
  if (!response || typeof response !== "object") return [];
  const values = (response as Record<string, unknown>).values;
  if (!Array.isArray(values)) return [];
  return values.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

async function safeRequest(
  client: TripletexClient,
  method: "GET",
  path: string,
  params?: Record<string, unknown>,
): Promise<SafeProbeResult> {
  try {
    const response = await client.request(method, path, params ? { params } : undefined);
    return { ok: true, response };
  } catch (error) {
    if (error instanceof TripletexError) {
      return {
        ok: false,
        statusCode: error.statusCode,
        error: `${error.endpoint} ${error.statusCode ?? "n/a"} ${error.message}`,
      };
    }
    return {
      ok: false,
      error: String(error),
    };
  }
}

export async function probeTripletexCapabilities(client: TripletexClient): Promise<TripletexCapabilities> {
  const capabilities: TripletexCapabilities = {
    modules: {
      departmentAccounting: null,
      productAccounting: null,
      projectAccounting: null,
      wageProjectAccounting: null,
      fixedAssetRegister: null,
    },
    dimensions: {
      freeDimensionSlotsUsed: null,
      freeDimensionSlotsAvailable: null,
    },
    bank: {
      hasStatements: null,
      hasReconciliations: null,
      hasReconciliationSettings: null,
    },
    assets: {
      featureAvailable: null,
      hasAssets: null,
    },
    probeErrors: [],
  };

  const [modulesResult, dimensionNamesResult, bankStatementsResult, bankReconciliationsResult, bankSettingsResult, assetsExistResult] =
    await Promise.all([
      safeRequest(client, "GET", "/company/modules"),
      safeRequest(client, "GET", "/ledger/accountingDimensionName", { count: 10, fields: "id,dimensionIndex,active" }),
      safeRequest(client, "GET", "/bank/statement", { count: 1, fields: "id" }),
      safeRequest(client, "GET", "/bank/reconciliation", { count: 1, fields: "id" }),
      safeRequest(client, "GET", "/bank/reconciliation/settings", { fields: "id" }),
      safeRequest(client, "GET", "/asset/assetsExist"),
    ]);

  if (modulesResult.ok) {
    const modules = primaryValue(modulesResult.response);
    if (modules && typeof modules === "object") {
      const value = modules as Record<string, unknown>;
      capabilities.modules.departmentAccounting = typeof value.moduleDepartmentAccounting === "boolean" ? value.moduleDepartmentAccounting : null;
      capabilities.modules.productAccounting = typeof value.moduleProductAccounting === "boolean" ? value.moduleProductAccounting : null;
      capabilities.modules.projectAccounting = typeof value.moduleProjectAccounting === "boolean" ? value.moduleProjectAccounting : null;
      capabilities.modules.wageProjectAccounting = typeof value.moduleWageProjectAccounting === "boolean" ? value.moduleWageProjectAccounting : null;
      capabilities.modules.fixedAssetRegister = typeof value.moduleFixedAssetRegister === "boolean" ? value.moduleFixedAssetRegister : null;
    }
  } else {
    capabilities.probeErrors.push(modulesResult.error);
  }

  if (dimensionNamesResult.ok) {
    const used = toValues(dimensionNamesResult.response)
      .filter((item) => item.active !== false)
      .length;
    capabilities.dimensions.freeDimensionSlotsUsed = used;
    capabilities.dimensions.freeDimensionSlotsAvailable = Math.max(0, 3 - used);
  } else {
    capabilities.probeErrors.push(dimensionNamesResult.error);
  }

  if (bankStatementsResult.ok) {
    capabilities.bank.hasStatements = toValues(bankStatementsResult.response).length > 0;
  } else {
    capabilities.probeErrors.push(bankStatementsResult.error);
  }

  if (bankReconciliationsResult.ok) {
    capabilities.bank.hasReconciliations = toValues(bankReconciliationsResult.response).length > 0;
  } else {
    capabilities.probeErrors.push(bankReconciliationsResult.error);
  }

  if (bankSettingsResult.ok) {
    capabilities.bank.hasReconciliationSettings = primaryValue(bankSettingsResult.response) !== null;
  } else {
    capabilities.probeErrors.push(bankSettingsResult.error);
  }

  if (assetsExistResult.ok) {
    capabilities.assets.featureAvailable = true;
    const value = primaryValue(assetsExistResult.response);
    capabilities.assets.hasAssets = typeof value === "boolean" ? value : null;
  } else if (assetsExistResult.statusCode === 403) {
    capabilities.assets.featureAvailable = false;
    capabilities.assets.hasAssets = null;
  } else {
    capabilities.probeErrors.push(assetsExistResult.error);
  }

  return capabilities;
}

export function summarizeCapabilitiesForLog(capabilities: TripletexCapabilities): Record<string, unknown> {
  return {
    modules: capabilities.modules,
    dimensions: capabilities.dimensions,
    bank: capabilities.bank,
    assets: capabilities.assets,
    probeErrorCount: capabilities.probeErrors.length,
  };
}
