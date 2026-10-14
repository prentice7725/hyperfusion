import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class TransitionController {
 private final Task task = new Task();
 @PostMapping("/transition")
 public ResponseEntity<String> transition(@RequestParam("next") String next) {
  return task.transition(next) ? ResponseEntity.ok(task.state()) : ResponseEntity.status(409).body(task.state());
 }
}
