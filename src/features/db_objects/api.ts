// db-objects feature API surface (views / materialized views / functions /
// procedures / triggers). The wire types + invoke wrappers live next to the
// other engine types in `shared/api/engine.ts` (engine-shared, like
// `tableMeta`); this module re-exports them under the feature so the feature's
// components import from their own slice. Mirrors `features/structure/api.ts`.

export {
  listObjects,
  objectDefinition,
  dropObject,
  runObjectDdl,
  OBJECT_CAPS,
  type DbObjectKind,
  type DbObjectInfo,
  type DbObjectDefinition,
} from "../../shared/api/engine";
