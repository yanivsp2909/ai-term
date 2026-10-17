// A wait's deadline: fire runs after ms unless the returned cancel runs first. Code that races another process against
// the clock takes one as an option (B31): tests pass a manual one, so machine load can't decide which side wins.
export type Deadline = (ms: number, fire: () => void) => () => void;
