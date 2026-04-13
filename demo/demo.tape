Output demo/demo.gif
Set Theme "Dracula"
Set FontSize 14
Set Width 200
Set Height 52
Set Padding 10
Set PlaybackSpeed 1.5

# Initialize workspace
Type "agentboard init"
Enter
Sleep 2s

# Launch the TUI
Type "agentboard"
Enter
Sleep 1.5s

# Create a task
Type "n"
Sleep 0.3s
Type "Build authentication service"
Enter
Sleep 0.5s

# Move to In Progress
Type "]"
Sleep 0.3s

# Create another task
Type "n"
Sleep 0.3s
Type "Write unit tests for auth"
Enter
Sleep 0.5s

# Assign a pillar
Type "p"
Sleep 0.3s
Down
Enter
Sleep 0.5s

# Open a shell session
Enter
Sleep 1.5s

# Switch focus to terminal, type a command
Type "t"
Sleep 0.3s
Type "git log --oneline -5"
Enter
Sleep 1s

# Return to board
Escape
Sleep 0.5s

# Trigger sync
Type "s"
Sleep 1.5s

# Open help overlay
Type "?"
Sleep 1.5s
Escape

# Quit
Type "q"
Sleep 0.5s
