import org.junit.jupiter.api.Test;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
public class SpringAcceptanceTest {
 @Test void invalidTransitionReturnsConflictWithoutChangingState() throws Exception {
  var mvc=MockMvcBuilders.standaloneSetup(new TransitionController()).build();
  mvc.perform(post("/transition").param("next","CLOSED")).andExpect(status().isConflict()).andExpect(content().string("NEW"));
  mvc.perform(post("/transition").param("next","RUNNING")).andExpect(status().isOk()).andExpect(content().string("RUNNING"));
 }
}
