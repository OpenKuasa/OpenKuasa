/**
 * The operations the MCP server offers: exactly the tools Tuah has, from the same product
 * factories, under the same guard chain. Nothing here is a second copy of a tool.
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import { guardChain } from '@/lib/ai/agents/orchestrator';
import type { DeletionGate } from '@/lib/ai/hire-deletions';
import type { HeldCv } from '@/lib/ai/hire-tools';
import {
  combineToolkits,
  crmProduct,
  financeProduct,
  hireProduct,
  peopleProduct,
  reachProduct,
  type ProductKey,
  type ProductToolkit,
} from '@/lib/ai/products';
import type { TuahAccess } from '@/lib/ai/tuah-access';

export type Operation = {
  name: string;
  product: ProductKey;
  kind: 'read' | 'write';
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: unknown;
  tool: Tool;
};

export type Operations = {
  byName: Map<string, Operation>;
  gates: Record<string, 'user-approval' | DeletionGate> | undefined;
  products: ProductToolkit[];
  cvShelf: HeldCv[] | undefined;
};

const ANY_OBJECT = { type: 'object' };

/** JSON Schema from a tool's zod schema or `jsonSchema(...)` wrapper; anything else is any object. */
function toJsonSchema(tool: Tool): unknown {
  const schema = (tool as { inputSchema?: unknown }).inputSchema as
    | { jsonSchema?: unknown; _zod?: unknown }
    | undefined;
  if (!schema) return ANY_OBJECT;
  try {
    // The input side (what a caller sends); `unrepresentable: 'any'` keeps a transform or custom check from failing it.
    if (schema._zod) return z.toJSONSchema(schema as unknown as z.ZodType, { io: 'input', unrepresentable: 'any' });
    if (schema.jsonSchema) return schema.jsonSchema;
  } catch {
    // fall through
  }
  return ANY_OBJECT;
}

export function buildOperations(access: TuahAccess): Operations {
  const products: ProductToolkit[] = [reachProduct(access.reach)];
  if (access.crm) products.push(crmProduct(access.crm));
  products.push(hireProduct(access.hire));
  if (access.people) products.push(peopleProduct(access.people));
  if (access.finance) products.push(financeProduct(access.finance));

  const kit = combineToolkits(products);
  const byName = new Map<string, Operation>();
  for (const product of products) {
    for (const kind of ['read', 'write'] as const) {
      for (const [name, tool] of Object.entries(product[kind])) {
        byName.set(name, {
          name,
          product: product.key,
          kind,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: toJsonSchema(tool),
          tool,
        });
      }
    }
  }
  return {
    byName,
    gates: guardChain(products, kit.toolApproval),
    products,
    cvShelf: products.find((p) => p.cvShelf)?.cvShelf,
  };
}

export function listOperations(
  ops: Operations,
  product?: ProductKey,
): Array<Pick<Operation, 'name' | 'product' | 'kind' | 'description' | 'inputSchema'>> {
  return [...ops.byName.values()]
    .filter((o) => !product || o.product === product)
    .map(({ name, product: p, kind, description, inputSchema }) => ({ name, product: p, kind, description, inputSchema }));
}
