package com.example.order.domain;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;

/** bad.java: 负样本 —— 只有日期与金额计算，仍然不应命中任何线程池规则。 */
public class OrderAmountCalculator {

    private static final BigDecimal VIP_DISCOUNT = new BigDecimal("0.95");

    public BigDecimal total(List<OrderItem> items, boolean vip) {
        BigDecimal total = BigDecimal.ZERO;
        for (OrderItem item : items) {
            total = total.add(item.price().multiply(BigDecimal.valueOf(item.quantity())));
        }
        return vip ? total.multiply(VIP_DISCOUNT) : total;
    }

    public Duration retention(OrderItem item) {
        return Duration.ofDays(item.quantity() > 100 ? 90 : 30);
    }

    public record OrderItem(String sku, BigDecimal price, int quantity) {
    }
}
