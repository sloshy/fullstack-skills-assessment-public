import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Row } from 'antd'
import dayjs from 'dayjs'
import { Link, useNavigate } from 'react-router-dom'
import { errorMessage, isOutcomeUnknown } from '../api/client'
import { createPayment, quoteSurcharge, SurchargeQuote } from '../api/payments'
import { describeCard } from '../components/CardLabel'
import { useMerchant } from '../merchants/MerchantContext'
import { binOf, digitsOnly, formatCardNumber, isValidCardNumber, parseExpiry } from '../utils/card'
import { formatMoney, previewSurcharge } from '../utils/money'

type PaymentForm_Shape = {
  amount: number
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

export const NewPaymentPage = () => {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { merchant } = useMerchant()
  const [form] = Form.useForm<PaymentForm_Shape>()
  const [ submitting, setSubmitting ] = useState(false)
  const [ error, setError ] = useState<string>()
  const [ card, setCard ] = useState<SurchargeQuote>()
  const [ unknownAttempt, setUnknownAttempt ] = useState<UnknownAttempt>()
  // State updates land a render later, so a fast second submit could still see submitting=false
  const inFlight = useRef(false)

  const amount = Form.useWatch('amount', form) ?? 0
  const cardNumber = Form.useWatch('cardNumber', form)
  const bin = binOf(cardNumber ?? '')
  // DECISIONS.md 016: after an unknown outcome, Charge stays off for the same payment until the
  // operator says they've checked the list
  const blockedByUnknown = unknownAttempt?.values === attemptValues(amount, cardNumber)

  // only used for the card label under the input, the amount is a placeholder
  useEffect(() => {
    if (!bin) {
      setCard(undefined)
      return
    }
    let active = true
    quoteSurcharge(1, bin)
      .then(q => { if (active) setCard(q) })
      .catch(() => { if (active) setCard(undefined) })
    return () => { active = false }
  }, [bin])

  const surcharge = amount > 0 ? previewSurcharge(amount, merchant.surchargeRate) : 0
  const total = amount + surcharge

  const onFinish = async (values: PaymentForm_Shape) => {
    if (inFlight.current || blockedByUnknown) return
    const expiry = parseExpiry(values.expiry)!
    const cardDigits = digitsOnly(values.cardNumber)
    inFlight.current = true
    setSubmitting(true)
    setError(undefined)
    setUnknownAttempt(undefined)

    try {
      const payment = await createPayment({
        amount: values.amount,
        cardNumber: cardDigits,
        expiryMonth: expiry.month,
        expiryYear: expiry.year,
        cvv: values.cvv,
        customerName: values.customerName?.trim() || undefined,
      })

      if (payment.status === 'APPROVED') {
        message.success(`Approved: ${formatMoney(payment.total, payment.currency)}`)
      } else {
        message.warning('The card was declined.')
      }
      navigate(`/payments/${payment.id}`)
    } catch (e) {
      // DECISIONS.md 016: the operator checks first, which a retry would skip
      if (isOutcomeUnknown(e)) {
        setUnknownAttempt({
          total: formatMoney(total, merchant.currency),
          last4: cardDigits.slice(-4),
          at: new Date(),
          values: attemptValues(values.amount, values.cardNumber),
        })
      } else {
        setError(errorMessage(e))
      }
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

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
            <Form.Item label={`Amount (${merchant.currency})`} name='amount' rules={[{ required: true, message: 'Enter an amount' }]}>
              <InputNumber min={0.01} precision={2} style={{ width: '100%' }} placeholder='0.00' />
            </Form.Item>

            <Form.Item
              label='Card number'
              name='cardNumber'
              normalize={formatCardNumber}
              extra={card && describeCard(card.network, card.cardType)}
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
              disabled={submitting || blockedByUnknown}
              aria-describedby={blockedByUnknown ? 'unknown-outcome' : undefined}
            >
              Charge {formatMoney(total, merchant.currency)}
            </Button>
          </Form>
        </Card>
      </Col>

      <Col xs={24} md={10}>
        <Card title='Summary'>
          <dl className='summary'>
            <dt>Amount</dt>
            <dd>{formatMoney(amount, merchant.currency)}</dd>
            <dt>Card surcharge ({merchant.surchargeRate}%)</dt>
            <dd>{formatMoney(surcharge, merchant.currency)}</dd>
            <dt className='summary-total'>Total</dt>
            <dd className='summary-total'>{formatMoney(total, merchant.currency)}</dd>
          </dl>
        </Card>
      </Col>
    </Row>
  </>
}
