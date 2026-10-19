import { gComponentRegistry } from "../core/global_registries";
import { Logger } from "../core/logging";
import { Vector } from "../core/vector";
import { gBuildingVariants, getBuildingDataFromCode } from "../game/building_codes";
import { SerializerInternal } from "../savegame/serializer_internal";
import { CONFIGURABLE_COMPONENTS } from "./protocol";

/**
 * @typedef {import("../game/root").GameRoot} GameRoot
 * @typedef {import("../game/entity").Entity} Entity
 */

const logger = new Logger("mp/entity-sync");

const serializerInternal = new SerializerInternal();

/**
 * Verifies the component data of a serialized entity
 * @param {any} payload
 * @returns {string|null} error or null
 */
export function verifyEntityPayload(payload) {
    const staticData = payload?.components?.StaticMapEntity;
    if (!staticData || !Object.hasOwn(gBuildingVariants, staticData.code)) {
        return "invalid building code";
    }
    for (const componentId in payload.components) {
        const componentClass = gComponentRegistry.hasId(componentId)
            ? gComponentRegistry.findById(componentId)
            : null;
        if (!componentClass) {
            return "unknown component " + componentId;
        }
        const error = /** @type {any} */ (componentClass).verify(payload.components[componentId]);
        if (error) {
            return "component " + componentId + ": " + error;
        }
    }
    return null;
}

/**
 * Builds an entity from a serialized payload without registering it
 * @param {GameRoot} root
 * @param {any} payload
 * @returns {Entity}
 */
export function createEntityFromPayload(root, payload) {
    const staticData = payload.components.StaticMapEntity;
    const data = getBuildingDataFromCode(staticData.code);
    const entity = data.metaInstance.createEntity({
        root,
        origin: Vector.fromSerializedObject(staticData.origin),
        rotation: staticData.rotation,
        originalRotation: staticData.originalRotation,
        rotationVariant: data.rotationVariant,
        variant: data.variant,
    });
    const error = serializerInternal.deserializeComponents(root, entity, payload.components);
    if (error) {
        throw new Error("Failed to deserialize components: " + error);
    }
    return entity;
}

/**
 * Removes an entity from the map and destroys it right away
 * @param {GameRoot} root
 * @param {Entity} entity
 */
export function removeEntityNow(root, entity) {
    root.map.removeStaticEntity(entity);
    root.entityMgr.destroyEntity(entity);
    root.entityMgr.processDestroyList();
}

/**
 * Whether an existing entity matches a serialized one in position, rotation and building
 * @param {Entity} entity
 * @param {any} payload
 */
function hasSameStructure(entity, payload) {
    const own = entity.components.StaticMapEntity;
    const other = payload.components.StaticMapEntity;
    return (
        own.origin.x === other.origin.x &&
        own.origin.y === other.origin.y &&
        own.rotation === other.rotation &&
        own.originalRotation === other.originalRotation &&
        own.code === other.code
    );
}

/**
 * Applies only the user-configurable component state (levers, signals)
 * @param {GameRoot} root
 * @param {Entity} entity
 * @param {any} components
 */
export function applyConfigComponents(root, entity, components) {
    for (const componentId of CONFIGURABLE_COMPONENTS) {
        if (components[componentId] && entity.components[componentId]) {
            entity.components[componentId].deserialize(components[componentId], root);
        }
    }
}

/**
 * Applies authoritative entity state from the host. Must run while the
 * session's apply flag is set, so the client intercepts let the changes through.
 * @param {GameRoot} root
 * @param {{ added: any[], destroyed: number[], removeOthers?: boolean }} param1
 *   removeOthers: destroy every building that is not in `added` (used for full resyncs)
 */
export function applyEntityState(root, { added, destroyed, removeOthers = false }) {
    root.logic.performBulkOperation(() =>
        root.logic.performImmutableOperation(() => {
            const uidsToDestroy = new Set(destroyed);

            if (removeOthers) {
                const keep = new Set(added.map(payload => payload.uid));
                for (const [uid, entity] of root.entityMgr.getFrozenUidSearchMap()) {
                    if (entity.components.StaticMapEntity && !keep.has(uid)) {
                        uidsToDestroy.add(uid);
                    }
                }
            }

            for (const uid of uidsToDestroy) {
                const entity = root.entityMgr.findByUid(uid, false);
                if (entity) {
                    removeEntityNow(root, entity);
                }
            }

            for (const payload of added) {
                try {
                    upsertEntity(root, payload);
                } catch (ex) {
                    logger.error("Failed to apply entity", payload?.uid, ex);
                }
            }
        })
    );
}

/**
 * @param {GameRoot} root
 * @param {any} payload
 */
function upsertEntity(root, payload) {
    const existing = root.entityMgr.findByUid(payload.uid, false);
    if (existing) {
        if (hasSameStructure(existing, payload)) {
            applyConfigComponents(root, existing, payload.components);
            return;
        }
        removeEntityNow(root, existing);
    }

    const entity = createEntityFromPayload(root, payload);

    // Remove anything that is still in the way. Normally the host already sent
    // those removals, this only cleans up after drift.
    const rect = entity.components.StaticMapEntity.getTileSpaceBounds();
    for (let x = rect.x; x < rect.right(); ++x) {
        for (let y = rect.y; y < rect.bottom(); ++y) {
            const blocker = root.map.getLayerContentXY(x, y, entity.layer);
            if (blocker) {
                removeEntityNow(root, blocker);
            }
        }
    }

    root.map.placeStaticEntity(entity);
    root.entityMgr.registerEntity(entity, payload.uid);
    root.entityMgr.reserveUidsUpTo(payload.uid);
}

/**
 * Hashes the structure of the factory: which buildings exist, where they are,
 * how they are rotated and configured. Items on belts are not part of it.
 * @param {GameRoot} root
 */
export function computeStructureChecksum(root) {
    const parts = [];
    for (const [uid, entity] of root.entityMgr.getFrozenUidSearchMap()) {
        const staticComp = entity.components.StaticMapEntity;
        if (!staticComp) {
            continue;
        }
        let part =
            uid +
            ":" +
            staticComp.origin.x +
            "," +
            staticComp.origin.y +
            "," +
            staticComp.rotation +
            "," +
            staticComp.code;
        if (entity.components.Lever) {
            part += ",L" + (entity.components.Lever.toggled ? 1 : 0);
        }
        if (entity.components.ConstantSignal) {
            const signal = entity.components.ConstantSignal.signal;
            part += ",S" + (signal ? signal.getAsCopyableKey() : "-");
        }
        parts.push([uid, part]);
    }
    parts.sort((a, b) => a[0] - b[0]);

    // FNV-1a, 32 bit
    let hash = 0x811c9dc5;
    for (const [, part] of parts) {
        for (let i = 0; i < part.length; ++i) {
            hash ^= part.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        hash ^= 0x7c; // separator
        hash = Math.imul(hash, 0x01000193);
    }
    return { hash: (hash >>> 0).toString(16), count: parts.length };
}
