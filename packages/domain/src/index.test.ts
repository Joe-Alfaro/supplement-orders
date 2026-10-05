import { describe, expect, it } from 'vitest'
import { DOMAIN_PACKAGE_NAME } from './index'

describe('@supplement-orders/domain barrel', () => {
  it('exposes the package placeholder export', () => {
    expect(DOMAIN_PACKAGE_NAME).toBe('@supplement-orders/domain')
  })
})
