import { useRef, useState } from 'react'
import { Alert, App, Button, Card, Col, Form, Input, Row, Typography } from 'antd'
import dayjs from 'dayjs'
import { Link, useNavigate } from 'react-router-dom'
import { errorMessage } from '../api/client'
import { createPayment, SurchargeQuote } from '../api/payments'
import { describeCard } from '../components/CardLabel'
import { useMerchant } from '../merchants/MerchantContext'
import { isChargeable, isFallback, quoteInput, surchargeLabel } from '../payments/quote'
import { useSurchargeQuote } from '../payments/useSurchargeQuote'
import { classifyWriteError } from '../payments/writeErrors'
import { binOf, digitsOnly, formatCardNumber, isValidCardNumber, parseExpiry } from '../utils/card'
import { formatMinorWithExponent, formatMoney, fractionDigits, parseAmount } from '../utils/money'

const { Text } = Typography

type PaymentForm_Shape = {
  /** The amount exactly as typed; `parseAmount` reads it (DECISIONS.md 017). */
  amount: string
  cardNumber: string
  expiry: string
  cvv: string
  customerName?: string
}

/** A charge whose outcome is unknown, with what the operator needs to find it in the list. */
type UnknownAttempt = {
  total: string
  last4: string
  at: Date
  /** The amount and card it was for, so the same charge can't go again with one click. */
  values: string
}

const attemptValues = (amount: number | null | undefined, cardNumber: string | null | undefined) =>
  `${amount}|${digitsOnly(cardNumber ?? '')}`

const quoteMoney = (quote: SurchargeQuote, minor: number) =>
  formatMinorWithExponent(minor, quote.currencyExponent, quote.currency)

export const NewPaymentPage = () => {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { merchant } = useMerchant()
  const [form] = Form.useForm<PaymentForm_Shape>()
  const [ submitting, setSubmitting ] = useState(false)
  const [ error, setError ] = useState<string>()
  const [ unknownAttempt, setUnknownAttempt ] = useState<UnknownAttempt>()
  // State updates land a render later, so a fast second submit could still see submitting=false
  const inFlight = useRef(false)

  const digits = fractionDigits(merchant.currency)
  const readAmount = (text: string | undefined) => parseAmount(text ?? '', digits, merchant.currency)

  const amountText = Form.useWatch('amount', form)
  const parsedAmount = readAmount(amountText)
  // DECISIONS.md 017: an invalid amount is never quoted; the field shows what's wrong with it
  const amount = parsedAmount.ok ? parsedAmount.amount : undefined
  const cardNumber = Form.useWatch('cardNumber', form)
  const { view, latestQuote, requote } = useSurchargeQuote(amount, cardNumber)

  const bin = binOf(cardNumber ?? '')
  // A fallback quote never looked the card up, so it has nothing to say about it
  const cardQuote = latestQuote && latestQuote.bin === bin && !isFallback(latestQuote) ? latestQuote : undefined
  // DECISIONS.md 016: after an unknown outcome, Charge stays off for the same payment until the
  // operator says they've checked the list
  const blockedByUnknown = unknownAttempt?.values === attemptValues(amount, cardNumber)
  const canCharge = view.kind === 'ready' && !blockedByUnknown

  const onFinish = async (values: PaymentForm_Shape) => {
    // rule 4: charge exactly the quote on screen, and only while it's still good
    if (inFlight.current || blockedByUnknown) return
    const parsed = readAmount(values.amount)
    // Narrows the amount text to a number. It can't fail here: the field's validator blocks
    // submit for an invalid amount, so onFinish never runs with one.
    if (!parsed.ok) return
    const chargeAmount = parsed.amount
    if (view.kind !== 'ready' || !isChargeable(view, quoteInput(chargeAmount, values.cardNumber), Date.now())) {
      setError('The total is out of date. Wait for it to update, then charge again.')
      requote()
      return
    }
    const { quote } = view

    const expiry = parseExpiry(values.expiry)!
    const cardDigits = digitsOnly(values.cardNumber)
    inFlight.current = true
    setSubmitting(true)
    setError(undefined)
    setUnknownAttempt(undefined)

    try {
      const payment = await createPayment({
        amount: chargeAmount,
        cardNumber: cardDigits,
        expiryMonth: expiry.month,
        expiryYear: expiry.year,
        cvv: values.cvv,
        customerName: values.customerName?.trim() || undefined,
        quote,
      })

      if (payment.status === 'APPROVED') {
        message.success(`Approved: ${formatMoney(payment.total, payment.currency)}`)
      } else {
        message.warning('The card was declined.')
      }
      navigate(`/payments/${payment.id}`)
    } catch (e) {
      const failure = classifyWriteError(e)
      if (failure.kind === 'unknown') {
        setUnknownAttempt({
          total: quoteMoney(quote, quote.totalMinor),
          last4: cardDigits.slice(-4),
          at: new Date(),
          values: attemptValues(chargeAmount, values.cardNumber),
        })
      } else {
        if (failure.kind === 'requote') requote()
        setError(failure.message)
      }
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const summaryNote = () => {
    switch (view.kind) {
      case 'needs-amount': return 'Enter an amount to see the total'
      case 'needs-card': return 'Enter the card number to see the total'
      case 'quoting': return 'Calculating…'
      default: return undefined
    }
  }
  const note = summaryNote()

  return <>
    <header className='page-header'>
      <h1>New payment</h1>
    </header>

    <Row gutter={24}>
      <Col xs={24} md={14}>
        <Card>
          {unknownAttempt &&
            <Alert
              type='warning'
              showIcon
              message="We couldn't confirm whether this payment went through."
              description={<span id='unknown-outcome'>
                {unknownAttempt.total} on card ending {unknownAttempt.last4} at {dayjs(unknownAttempt.at).format('HH:mm:ss')}.
                {' '}Wait a moment, then refresh the <Link to='/'>payments list</Link> and look for it before charging again.
              </span>}
              action={<Button size='small' onClick={() => setUnknownAttempt(undefined)}>I&apos;ve checked the list</Button>}
              style={{ marginBottom: 16 }}
            />
          }
          {error && <Alert type='error' showIcon message='Payment failed' description={error} style={{ marginBottom: 16 }} />}

          <Form form={form} layout='vertical' requiredMark='optional' onFinish={onFinish} disabled={submitting}>
            <Form.Item
              label={`Amount (${merchant.currency})`}
              name='amount'
              rules={[
                { required: true, message: 'Enter an amount' },
                {
                  validator: (_, value: string | undefined) => {
                    if (!value) return Promise.resolve()
                    const parsed = readAmount(value)
                    return parsed.ok ? Promise.resolve() : Promise.reject(new Error(parsed.error))
                  },
                },
              ]}
              // A fallback for an amount the server refuses (a 422) that passed the check here
              {...(view.kind === 'invalid-amount' && {
                validateStatus: 'error',
                help: `That isn't a valid ${merchant.currency} amount`,
              })}
            >
              {/* DECISIONS.md 017: plain text, so the value is never rounded or rewritten on blur */}
              <Input inputMode='decimal' autoComplete='off' placeholder={(0).toFixed(digits)} />
            </Form.Item>

            <Form.Item
              label='Card number'
              name='cardNumber'
              normalize={formatCardNumber}
              extra={cardQuote && describeCard(cardQuote.network, cardQuote.cardType)}
              rules={[
                { required: true, message: 'Enter the card number' },
                {
                  validator: (_, value: string) => !value || isValidCardNumber(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error("That card number isn't valid")),
                },
              ]}
            >
              <Input inputMode='numeric' autoComplete='cc-number' placeholder='4111 1111 1111 1111' />
            </Form.Item>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label='Expiry'
                  name='expiry'
                  rules={[
                    { required: true, message: 'Enter the expiry date' },
                    {
                      validator: (_, value: string) => !value || parseExpiry(value)
                        ? Promise.resolve()
                        : Promise.reject(new Error('Use MM/YY')),
                    },
                  ]}
                >
                  <Input autoComplete='cc-exp' placeholder='MM/YY' maxLength={5} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label='CVV'
                  name='cvv'
                  rules={[
                    { required: true, message: 'Enter the CVV' },
                    { pattern: /^\d{3,4}$/, message: '3 or 4 digits' },
                  ]}
                >
                  <Input.Password inputMode='numeric' autoComplete='cc-csc' maxLength={4} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label='Customer name' name='customerName'>
              <Input autoComplete='cc-name' maxLength={100} />
            </Form.Item>

            <Button
              type='primary'
              htmlType='submit'
              size='large'
              block
              loading={submitting}
              disabled={submitting || !canCharge}
              aria-describedby={[
                blockedByUnknown && 'unknown-outcome',
                view.kind === 'error' && 'quote-error',
                note && 'summary-note',
              ].filter(Boolean).join(' ') || undefined}
            >
              {view.kind === 'ready' ? `Charge ${quoteMoney(view.quote, view.quote.totalMinor)}` : 'Charge'}
            </Button>
          </Form>
        </Card>
      </Col>

      <Col xs={24} md={10}>
        <Card title='Summary'>
          {view.kind === 'error' &&
            <Alert
              type='error'
              showIcon
              message="Couldn't work out the total"
              description={<span id='quote-error'>{errorMessage(view.error)}</span>}
              action={<Button size='small' onClick={requote}>Try again</Button>}
              style={{ marginBottom: 16 }}
            />
          }
          {view.kind === 'ready'
            ? <dl className='summary'>
                <dt>Amount</dt>
                <dd>{quoteMoney(view.quote, view.quote.amountMinor)}</dd>
                <dt>{surchargeLabel(view.quote)}</dt>
                <dd>{quoteMoney(view.quote, view.quote.surchargeMinor)}</dd>
                <dt className='summary-total'>Total</dt>
                <dd className='summary-total'>{quoteMoney(view.quote, view.quote.totalMinor)}</dd>
              </dl>
            : amount === undefined
              // DECISIONS.md 017: no made-up figure for an amount that can't be read
              ? <dl className='summary'>
                  <dt>Amount</dt>
                  <dd>—</dd>
                  <dt>Surcharge</dt>
                  <dd>—</dd>
                  <dt className='summary-total'>Total</dt>
                  <dd className='summary-total'>—</dd>
                </dl>
              : <dl className='summary'>
                  <dt>Amount</dt>
                  <dd>{formatMoney(amount, merchant.currency)}</dd>
                </dl>
          }
          {note && <Text id='summary-note' type='secondary' style={{ display: 'block', marginTop: 12 }}>{note}</Text>}
        </Card>
      </Col>
    </Row>
  </>
}
