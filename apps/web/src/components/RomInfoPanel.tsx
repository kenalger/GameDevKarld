import { CARTRIDGE_TYPES } from '@webboy/emulator';
import { session } from '../emulator/EmulatorSession.js';

const kb = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(0)} MB`
    : `${Math.round(bytes / 1024)} KB`;

/**
 * Cartridge details, straight from the header parser.
 *
 * Doubles as a user-facing diagnostic: when a game misbehaves, "MBC5, 128 KB RAM, checksum
 * invalid" is the first thing worth knowing, and it saves a support round-trip.
 */
export function RomInfoPanel(): React.JSX.Element | null {
  const info = session.getCartridgeInfo();
  if (!info) return null;

  const rows: [string, string][] = [
    ['Title', info.title || '(untitled)'],
    ['System', info.system],
    [
      'Mapper',
      CARTRIDGE_TYPES[info.cartridgeType] ?? `unknown (0x${info.cartridgeType.toString(16)})`,
    ],
    ['ROM', kb(info.romSize)],
    ['RAM', info.ramSize > 0 ? kb(info.ramSize) : 'none'],
    ['Header checksum', info.headerChecksumValid ? 'valid' : 'INVALID'],
  ];

  return (
    <section className="panel">
      <h2 className="panel-title">Cartridge</h2>
      <dl className="info">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd data-warn={value === 'INVALID' ? 'true' : undefined}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
