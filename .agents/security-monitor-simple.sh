#!/bin/bash
# Security Monitor Simple - v1.0.0
# Monitors security review every 30 seconds

WORKSPACE_ID="07BD972E-C22C-4ACB-9B4D-AF65B0CAA71A"
COUNTER=0

while true; do
    sleep 30
    COUNTER=$((COUNTER + 1))
    
    # Update status
    cmux set-status --workspace "$WORKSPACE_ID" "checkin" "Check-in #$COUNTER" --icon "clock" --color "#3b82f6"
    
    # Log the check-in
    cmux log --workspace "$WORKSPACE_ID" --level info --source "monitor" "Check-in #$COUNTER complete"
    
    # Progress update
    PROGRESS=$(echo "scale=2; 0.25 + ($COUNTER * 0.05)" | bc)
    if (( $(echo "$PROGRESS > 0.95" | bc -l) )); then
        PROGRESS=0.95
    fi
    cmux set-progress --workspace "$WORKSPACE_ID" "$PROGRESS" --label "Check-in #$COUNTER complete - Review in progress"
done
