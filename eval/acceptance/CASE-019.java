import java.math.BigDecimal;
import java.util.List;

/** Functional regression: input data and expected totals are independent of rule checks. */
class AcceptanceTest {
    public static void main(String[] args) throws Exception {
        Class<?> target = Class.forName(args[0]);
        Object calculator = target.getConstructor().newInstance();
        Class<?> item = Class.forName(args[0] + "$OrderItem");
        var constructor = item.getConstructor(String.class, BigDecimal.class, int.class);
        var total = target.getMethod("total", List.class, boolean.class);
        var items = List.of(constructor.newInstance("A", new BigDecimal("10.25"), 2),
                            constructor.newInstance("B", new BigDecimal("3.50"), 3));
        check((BigDecimal) total.invoke(calculator, items, false), "31.00");
        check((BigDecimal) total.invoke(calculator, items, true), "29.4500");
        check((BigDecimal) total.invoke(calculator, List.of(), false), "0");
    }
    static void check(BigDecimal actual, String expected) {
        if (actual.compareTo(new BigDecimal(expected)) != 0) throw new AssertionError(actual + " != " + expected);
    }
}
