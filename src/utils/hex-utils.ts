import { BigNumber } from 'ethers'

export const fromHexString = (buf: Buffer | string): Buffer => {
  if (typeof buf === 'string' && buf.startsWith('0x')) {
    return Buffer.from(buf.slice(2), 'hex')
  }

  return Buffer.from(buf)
}

export const toHexString = (buf: Buffer | string | number | null): string => {
  if (typeof buf === 'number') {
    return BigNumber.from(buf).toHexString()
  } else {
    return '0x' + fromHexString(buf).toString('hex')
  }
}

export const toUnpaddedHexString = (buf: Buffer | string | number): string => {
  const hex = '0x' +
    toHexString(buf)
      .slice(2)
      .replace(/^0+/, '')

  if (hex === '0x') {
    return '0x0'
  } else {
    return hex
  }
}
