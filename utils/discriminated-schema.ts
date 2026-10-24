import { Type, type Static, type TObject, type TUnion } from 'typebox';

/** preserve union validation while reporting fields only from the selected string discriminator. */
export default function discriminatedSchema<T extends TUnion<TObject[]>>(
  discriminator: string,
  schema: T,
) {
  return Type.Unsafe<Static<T>>({
    type: 'object',
    properties: {
      [discriminator]: Type.Union(
        schema.anyOf.map((variant) => variant.properties[discriminator]!),
      ),
    },
    required: [discriminator],
    allOf: schema.anyOf.map((variant) => ({
      // typebox retains leaf diagnostics in else; a failing then reports only its guard.
      if: { not: Type.Object({ [discriminator]: variant.properties[discriminator]! }) },
      then: true,
      else: variant,
    })),
  });
}
