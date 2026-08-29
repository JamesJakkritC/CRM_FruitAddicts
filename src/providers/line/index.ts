import type { LineProvider } from './adapter.ts';
import { MockLineProvider } from './mock.ts';
import { RealLineProvider } from './real.ts';
import { config } from '../../config.ts';

let provider: LineProvider | null = null;

export function getLineProvider(): LineProvider {
  if (provider) return provider;
  provider = config.line.provider === 'line' ? new RealLineProvider() : new MockLineProvider();
  return provider;
}

export type { LineProvider } from './adapter.ts';
