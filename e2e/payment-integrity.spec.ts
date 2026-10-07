import { expect, type Page, test } from '@playwright/test'
import { addProduct, openPatient, readSplit, signIn } from './flow'
import { dollarsToCents, moneyIn } from './money'

// Revision 9. A patient page left open across cancel, reopen, reprice, and
// resend must not pay until it shows the new total. Jordan's order is paid
// here; specs that count that patient's paid rows sort ahead of this file.

const PROVIDER = 'Dr. Maya Rivera (Provider)'
const PATIENT = 'Jordan Lee'
const PATIENT_USER = 'Jordan Lee (Patient)'
const SKU = 'VITD3'
const REPRICED = '25.00'
const ORDER_CHANGED =
  'This order changed since you opened it. Review the new total before paying.'

test('a stale patient page shows that the order changed and pays the new total after reload', async ({
  browser,
}) => {
  const providerContext = await browser.newContext()
  const patientContext = await browser.newContext()
  try {
    const provider = await providerContext.newPage()
    const patient = await patientContext.newPage()
    let originalCents = 0
    let repricedCents = 0

    await test.step('provider sends an order and the patient opens it', async () => {
      await signIn(provider, PROVIDER)
      await openPatient(provider, PATIENT)
      await provider.getByRole('link', { name: 'New order' }).click()
      await addProduct(provider, SKU, { quantity: 1 })
      await provider.getByRole('button', { name: 'Send to patient' }).click()
      await expect(provider.getByRole('heading', { level: 1 })).toContainText(
        'Awaiting payment',
      )

      await signIn(patient, PATIENT_USER)
      const awaiting = patient
        .getByRole('table', { name: 'My orders' })
        .getByRole('row', { name: 'Awaiting payment' })
      await expect(awaiting).toHaveCount(1)
      await awaiting.click()
      await expect(patient.getByRole('heading', { level: 1 })).toContainText(
        'Awaiting payment',
      )
      originalCents = moneyIn(
        await patient.getByRole('table', { name: 'Order total' }).innerText(),
      )
      await expect(
        patient.getByRole('button', { name: /^Pay \$/ }),
      ).toBeEnabled()
    })

    await test.step('provider cancels, reopens, reprices, and resends', async () => {
      await confirmAction(provider, 'Cancel order')
      await expect(provider.getByRole('heading', { level: 1 })).toContainText(
        'Cancelled',
      )
      await confirmAction(provider, 'Reopen as draft')
      await expect(provider.getByRole('heading', { level: 1 })).toContainText(
        'Draft order',
      )

      // Pricing is read-only in the table; reprice through the Edit dialog.
      await provider.getByRole('button', { name: /^Edit / }).click()
      const dialog = provider.getByRole('dialog')
      const price = dialog.getByLabel('Patient price (each)')
      await expect(price).toBeVisible()
      await price.fill(REPRICED)
      await price.blur()
      await expect
        .poll(async () => dollarsToCents(await price.inputValue()))
        .toBe(2_500)
      await dialog.getByRole('button', { name: 'Save changes' }).click()
      await expect(dialog).toBeHidden()
      const split = await readSplit(provider)
      expect(split.patientPaysCents).toBe(2_500)
      expect(split.patientPaysCents).not.toBe(originalCents)
      repricedCents = split.patientPaysCents

      await provider.getByRole('button', { name: 'Send to patient' }).click()
      await expect(provider.getByRole('heading', { level: 1 })).toContainText(
        'Awaiting payment',
      )
    })

    await test.step('the open patient page refuses the old total', async () => {
      expect(
        moneyIn(
          await patient.getByRole('table', { name: 'Order total' }).innerText(),
        ),
      ).toBe(originalCents)
      await patient.getByRole('button', { name: /^Pay \$/ }).click()

      await expect(patient.getByText(ORDER_CHANGED)).toBeVisible()
      await expect
        .poll(async () =>
          moneyIn(
            await patient
              .getByRole('table', { name: 'Order total' })
              .innerText(),
          ),
        )
        .toBe(repricedCents)
      await expect(
        patient.getByRole('region', { name: 'Receipt' }),
      ).toHaveCount(0)
      await expect(
        patient.getByRole('heading', { name: 'Receipt' }),
      ).toHaveCount(0)
      await expect(patient.getByText(/Payment reference:/)).toHaveCount(0)
    })

    await test.step('after reload the patient pays the new total', async () => {
      await patient.reload()
      await expect(patient.getByRole('heading', { level: 1 })).toContainText(
        'Awaiting payment',
      )
      expect(
        moneyIn(
          await patient.getByRole('table', { name: 'Order total' }).innerText(),
        ),
      ).toBe(repricedCents)
      await patient.getByRole('button', { name: /^Pay \$/ }).click()
      const receipt = patient.getByRole('region', { name: 'Receipt' })
      await expect(receipt.getByRole('status')).toContainText('Paid')
      expect(moneyIn(await receipt.innerText())).toBe(repricedCents)
    })
  } finally {
    await patientContext.close()
    await providerContext.close()
  }
})

async function confirmAction(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name })
  await dialog.getByRole('button', { name, exact: true }).click()
  await expect(dialog).toBeHidden()
}
