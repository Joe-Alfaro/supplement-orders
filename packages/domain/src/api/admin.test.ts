import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  ROLES,
  STOCK_QUANTITY_MAX,
  adminProductDtoSchema,
  adminProductPageDtoSchema,
  apiErrorResponseSchema,
  incrementStockRequestSchema,
  listAdminProductsQuerySchema,
  setStockRequestSchema,
  stockChangedErrorResponseSchema,
  userDtoSchema,
} from '../index'

// Revision 13: admin inventory management.

describe('admin role', () => {
  it('is a role, and an admin user has neither a provider nor a patient id', () => {
    expect(ROLES).toContain('admin')
    expect(
      userDtoSchema.safeParse({
        id: 7,
        name: 'Ada Admin',
        role: 'admin',
        providerId: null,
        patientId: null,
      }).success,
    ).toBe(true)
  })
})

describe('incrementStockRequestSchema', () => {
  it('accepts whole numbers from 1 to 1,000,000', () => {
    expect(STOCK_QUANTITY_MAX).toBe(1_000_000)
    expect(incrementStockRequestSchema.parse({ by: 1 })).toEqual({ by: 1 })
    expect(incrementStockRequestSchema.parse({ by: 1_000_000 })).toEqual({
      by: 1_000_000,
    })
  })

  it.each([0, -1, 1.5, 1_000_001, '5', null, Number.NaN])(
    'rejects by = %s on the by field',
    (by) => {
      const result = incrementStockRequestSchema.safeParse({ by })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['by'])
    },
  )

  it('rejects a missing by and unknown keys', () => {
    expect(incrementStockRequestSchema.safeParse({}).success).toBe(false)
    expect(
      incrementStockRequestSchema.safeParse({ by: 1, stockQuantity: 5 })
        .success,
    ).toBe(false)
  })
})

describe('setStockRequestSchema', () => {
  it('accepts whole numbers from 0 to 1,000,000 for both values', () => {
    expect(
      setStockRequestSchema.parse({
        stockQuantity: 0,
        expectedStockQuantity: 1_000_000,
      }),
    ).toEqual({ stockQuantity: 0, expectedStockQuantity: 1_000_000 })
  })

  it.each([
    [{ stockQuantity: -1, expectedStockQuantity: 5 }, 'stockQuantity'],
    [{ stockQuantity: 2.5, expectedStockQuantity: 5 }, 'stockQuantity'],
    [{ stockQuantity: 1_000_001, expectedStockQuantity: 5 }, 'stockQuantity'],
    [{ stockQuantity: 5, expectedStockQuantity: -1 }, 'expectedStockQuantity'],
    [{ stockQuantity: 5, expectedStockQuantity: 0.5 }, 'expectedStockQuantity'],
    [{ stockQuantity: 5 }, 'expectedStockQuantity'],
  ])('rejects %j on %s', (body, field) => {
    const result = setStockRequestSchema.safeParse(body)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual([field])
  })
})

describe('admin product DTOs', () => {
  it('carries id, name, wholesale cost and stock in the standard page', () => {
    const item = {
      id: 1,
      name: 'Vitamin D3',
      wholesaleCostCents: 850,
      stockQuantity: 120,
    }
    expect(adminProductDtoSchema.parse(item)).toEqual(item)
    expect(
      adminProductPageDtoSchema.safeParse({
        items: [item],
        total: 1,
        offset: 0,
        limit: 25,
      }).success,
    ).toBe(true)
  })

  it('lists with the shared q/offset/limit query', () => {
    expect(listAdminProductsQuerySchema.parse({ q: ' vit ' })).toEqual({
      q: 'vit',
      offset: 0,
      limit: 25,
    })
  })
})

describe('STOCK_CHANGED', () => {
  it('is an error code whose body carries the current stock', () => {
    expect(API_ERROR_CODES).toContain('STOCK_CHANGED')
    const body = {
      error: {
        code: 'STOCK_CHANGED',
        message: 'Stock changed',
        currentStockQuantity: 37,
      },
    }
    expect(stockChangedErrorResponseSchema.parse(body)).toEqual(body)
    expect(apiErrorResponseSchema.parse(body)).toEqual(body)
    expect(
      stockChangedErrorResponseSchema.safeParse({
        error: { code: 'STOCK_CHANGED', message: 'x' },
      }).success,
    ).toBe(false)
  })
})
