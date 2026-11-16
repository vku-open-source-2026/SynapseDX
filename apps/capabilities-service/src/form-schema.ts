// SPDX-License-Identifier: Apache-2.0
/** Draft-7 validation for schemas authored in the native form designer. */
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { apiError } from "./errors";

const validators = new Map<string, ValidateFunction>();

function compile(schema: Record<string, any>): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = validators.get(key);
  if (cached) return cached;
  // No remote loader, coercion, defaults or deletion of submitted properties.
  const ajv = new Ajv({ allErrors: true, ownProperties: true, strictTypes: false, strictTuples: false, strictRequired: false });
  addFormats(ajv);
  ajv.addKeyword({ keyword: "visibleWhen", schemaType: "object", valid: true,
    metaSchema: { type: "object", required: ["field", "equals"], properties: { field: { type: "string", minLength: 1 }, equals: {} }, additionalProperties: false } });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
    if ("$async" in validate && validate.$async) throw new Error("Async schemas are unsupported");
  } catch {
    throw apiError(400, "invalid_request", "Use a valid synchronous JSON Schema draft-7 form schema with local references and supported formats");
  }
  if (validators.size >= 32) validators.delete(validators.keys().next().value!);
  validators.set(key, validate);
  return validate;
}

export function validateFormSchema(schema: Record<string, any>): void {
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw apiError(400, "invalid_request", "form schema must be an object schema with properties");
  }
  compile(schema);
}

export function validateFormValues(schema: Record<string, any>, values: Record<string, any>): string[] {
  const properties = { ...schema.properties };
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const nonempty: string[] = [];
  for (const [name, definition] of Object.entries<any>(properties)) {
    const when = definition && typeof definition === "object" ? definition.visibleWhen : undefined;
    if (!when) continue;
    if (Object.hasOwn(values, when.field) && values[when.field] === when.equals) required.add(name);
    else {
      // Existing hidden conditional fields are optional and ignored. Keeping
      // their names declared also respects additionalProperties:false.
      properties[name] = true;
      required.delete(name);
    }
  }
  for (const name of required) {
    if (values[name] === "" || values[name] === null) nonempty.push(`${name} is required`);
  }
  const validate = compile({ ...schema, properties, required: [...required] });
  if (validate(values)) return nonempty;
  return [...nonempty, ...(validate.errors || []).slice(0, 32).map(error => {
    const field = error.keyword === "required" ? error.params.missingProperty : error.keyword === "additionalProperties" ? error.params.additionalProperty : "";
    return `${error.instancePath || "/"}${field ? ` ${field}` : ""} ${error.message || "is invalid"}`;
  })];
}
