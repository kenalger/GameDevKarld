/**
 * Every subsystem that holds state implements this. `gb-memory-engineer` owns the
 * container format, the magic number, the version field and the migration path
 * (Phase 08) — subsystems only supply and restore their own section.
 */
export interface Serializable {
  serialize(): ArrayBuffer;
  deserialize(data: ArrayBuffer): void;
}
