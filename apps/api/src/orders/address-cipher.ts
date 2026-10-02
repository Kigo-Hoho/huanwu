import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { OrderAddressViewSchema, type OrderAddressView, type OrderSide } from '@barter/contracts';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export interface AddressContext { orderId: string; side: OrderSide; version: number }
export interface EncryptedAddress { keyVersion: string; nonce: Uint8Array<ArrayBuffer>; tag: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> }

const contextSchema = OrderAddressViewSchema.pick({ orderId: true, side: true, version: true });
const unavailable = () => new ServiceUnavailableException({ code: 'INTEGRATION_UNAVAILABLE', message: 'Address encryption is unavailable' });
function configuration() {
  const encoded = process.env.ADDRESS_ENCRYPTION_KEY_BASE64;
  const keyVersion = process.env.ADDRESS_ENCRYPTION_KEY_VERSION;
  if (!encoded || !keyVersion || keyVersion !== keyVersion.trim() || keyVersion.length > 100) throw unavailable();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw unavailable();
  return { key, keyVersion };
}
function aad(context: AddressContext, keyVersion: string): Buffer {
  return Buffer.from(JSON.stringify(['order-address-v1', context.orderId, context.side, context.version, keyVersion]));
}
function sameContext(address: OrderAddressView, context: AddressContext): boolean {
  return address.orderId === context.orderId && address.side === context.side && address.version === context.version;
}

@Injectable()
export class AddressCipher {
  encrypt(address: OrderAddressView, context: AddressContext): EncryptedAddress {
    try {
      const { key, keyVersion } = configuration();
      const parsedContext = contextSchema.parse(context);
      const parsed = OrderAddressViewSchema.parse(address);
      if (!sameContext(parsed, parsedContext)) throw unavailable();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad(parsedContext, keyVersion));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed), 'utf8'), cipher.final()]);
      return { keyVersion, nonce, tag: cipher.getAuthTag(), ciphertext };
    } catch { throw unavailable(); }
  }
  decrypt(value: EncryptedAddress, context: AddressContext): OrderAddressView {
    try {
      const { key, keyVersion } = configuration();
      const parsedContext = contextSchema.parse(context);
      if (value.keyVersion !== keyVersion || !(value.nonce instanceof Uint8Array) || value.nonce.length !== 12 || !(value.tag instanceof Uint8Array) || value.tag.length !== 16 || !(value.ciphertext instanceof Uint8Array) || value.ciphertext.length === 0 || value.ciphertext.length > 4096) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', key, value.nonce, { authTagLength: 16 });
      decipher.setAAD(aad(parsedContext, keyVersion));
      decipher.setAuthTag(value.tag);
      // No plaintext is parsed or returned until final() authenticates the entire message.
      const plaintext = Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
      const address = OrderAddressViewSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
      if (!sameContext(address, parsedContext)) throw unavailable();
      return address;
    } catch { throw unavailable(); }
  }
}
