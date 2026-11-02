import java.util.function.Consumer;
public class EventPublisher {
    private final Consumer<String> receiver;
    public EventPublisher(Consumer<String> receiver){this.receiver=java.util.Objects.requireNonNull(receiver);}
    public void publish(String event){receiver.accept(event);}
    public void stop(){}
}
