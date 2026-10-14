// Typings for the Digital Bazaar status list library, used in tests as a cross-check only.
declare module '@digitalbazaar/vc-bitstring-status-list' {
  export interface BitstringStatusList {
    length: number;
    setStatus(index: number, status: boolean): void;
    getStatus(index: number): boolean;
    encode(): Promise<string>;
  }

  export function createList(options: { length: number }): Promise<BitstringStatusList>;
  export function decodeList(options: { encodedList: string }): Promise<BitstringStatusList>;
}
