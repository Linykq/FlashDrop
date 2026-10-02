import { DROP_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from '@flashdrop/domain';
import { pgEnum } from 'drizzle-orm/pg-core';

export const dropStatus = pgEnum('drop_status', DROP_STATUSES);
export const orderStatus = pgEnum('order_status', ORDER_STATUSES);
export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES);
