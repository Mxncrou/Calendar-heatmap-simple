This is a simple calendar heatmap.

Here a self-explanatory example:

```calendar-heatmap
trackers:
  - id: mood
    title: Mood
    icon: smile
    type: int
    min: 1
    max: 5
    colorMode: gradient
    colors: ["#f2706a", "#41b966"]
    showNumbers: false
  - id: workout
    title: Workout 
    icon: zap
    type: time
    min: 0
    max: 1440
    colorMode: gradient
    colors: ["#f2706a", "#42a3fe"]
    egradient: true
    unit: "time"
    showNumbers: true
  - id: sleep
    title: Sleep
    icon: moon
    type: time
    min: 0
    max: 1440
    showNumbers: false
    colorMode: gradient
    fgradient:
      - value: 240
        color: "#f2706a"
      - value: 480
        color: "#42a3fe"
      - value: 720
        color: "#f2706a"
    unit: "time"    
```
