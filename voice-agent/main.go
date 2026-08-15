package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// Config holds all service configuration
type Config struct {
	LiveKitHost   string  `json:"livekitHost"` // e.g. "ws://localhost:7880"
	LiveKitAPIKey string  `json:"livekitApiKey"`
	LiveKitSecret string  `json:"livekitSecret"`
	VoiceRange    float64 `json:"voiceRange"` // proximity range in game units
	RoomPrefix    string  `json:"roomPrefix"` // e.g. "eruvos"
	TickRateMs    int     `json:"tickRateMs"` // how often to run proximity checks
	MaxStreams    int     `json:"maxStreams"` // max audio streams per listener
}

// PlayerPosition represents a player's position in the game world
type PlayerPosition struct {
	X           float64 `json:"x"`
	Y           float64 `json:"y"`
	Z           float64 `json:"z"`
	WorldOrCell uint32  `json:"worldOrCell"`
}

// VoiceAgent manages proximity-based voice chat via LiveKit
type VoiceAgent struct {
	config  Config
	roomSvc *lksdk.RoomServiceClient

	// Player positions updated via HTTP API
	mu        sync.RWMutex
	positions map[string]PlayerPosition // identity -> position

	// Track subscription state (to avoid redundant API calls)
	subState map[string]map[string]bool // listener -> speaker -> subscribed
}

func NewVoiceAgent(config Config) *VoiceAgent {
	return &VoiceAgent{
		config:    config,
		positions: make(map[string]PlayerPosition),
		subState:  make(map[string]map[string]bool),
	}
}

func (va *VoiceAgent) Start(ctx context.Context) error {
	// Create LiveKit room service client
	va.roomSvc = lksdk.NewRoomServiceClient(
		va.config.LiveKitHost,
		va.config.LiveKitAPIKey,
		va.config.LiveKitSecret,
	)

	// Start HTTP API for position updates
	go va.startHTTPServer(ctx)

	log.Println("Voice agent started")
	<-ctx.Done()
	return nil
}

// startHTTPServer runs a small HTTP API for external position updates
func (va *VoiceAgent) startHTTPServer(ctx context.Context) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/position", va.handlePositionUpdate)
	mux.HandleFunc("/api/positions", va.handleGetPositions)
	mux.HandleFunc("/api/room-info", va.handleRoomInfo)
	mux.HandleFunc("/api/force-subscribe-all", va.handleForceSubscribeAll)

	server := &http.Server{
		Addr:    ":8090",
		Handler: mux,
	}

	go func() {
		<-ctx.Done()
		server.Close()
	}()

	log.Println("HTTP API listening on :8090")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("HTTP server error: %v", err)
	}
}

func (va *VoiceAgent) handlePositionUpdate(w http.ResponseWriter, r *http.Request) {
	// CORS for browser test page
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != "POST" {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Identity    string  `json:"identity"`
		X           float64 `json:"x"`
		Y           float64 `json:"y"`
		Z           float64 `json:"z"`
		WorldOrCell uint32  `json:"worldOrCell"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Identity == "" {
		http.Error(w, "identity required", http.StatusBadRequest)
		return
	}

	// Also update local positions
	va.mu.Lock()
	va.positions[req.Identity] = PlayerPosition{
		X: req.X, Y: req.Y, Z: req.Z, WorldOrCell: req.WorldOrCell,
	}
	va.mu.Unlock()

	log.Printf("Position updated via HTTP: %s -> (%.0f, %.0f, %.0f) world=%d",
		req.Identity, req.X, req.Y, req.Z, req.WorldOrCell)

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// handleGetPositions returns all known participant positions
func (va *VoiceAgent) handleGetPositions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	va.mu.RLock()
	positions := make(map[string]PlayerPosition, len(va.positions))
	for k, v := range va.positions {
		positions[k] = v
	}
	va.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"positions": positions,
	})
}

// handleRoomInfo returns the current LiveKit room state (participants + tracks)
func (va *VoiceAgent) handleRoomInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	roomName := fmt.Sprintf("%s-voice", va.config.RoomPrefix)
	participants, err := va.roomSvc.ListParticipants(r.Context(), &livekit.ListParticipantsRequest{
		Room: roomName,
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("ListParticipants error: %v", err), http.StatusInternalServerError)
		return
	}

	type trackInfo struct {
		SID    string `json:"sid"`
		Name   string `json:"name"`
		Type   string `json:"type"`
		Source string `json:"source"`
		Muted  bool   `json:"muted"`
	}
	type participantInfo struct {
		Identity string      `json:"identity"`
		SID      string      `json:"sid"`
		State    string      `json:"state"`
		Tracks   []trackInfo `json:"tracks"`
	}

	var result []participantInfo
	for _, p := range participants.Participants {
		pi := participantInfo{
			Identity: p.Identity,
			SID:      p.Sid,
			State:    p.State.String(),
		}
		for _, t := range p.Tracks {
			pi.Tracks = append(pi.Tracks, trackInfo{
				SID:    t.Sid,
				Name:   t.Name,
				Type:   t.Type.String(),
				Source: t.Source.String(),
				Muted:  t.Muted,
			})
		}
		result = append(result, pi)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"room":         roomName,
		"participants": result,
	})
}

// handleForceSubscribeAll subscribes every participant to every other
// participant's audio tracks (used for debugging subscription issues)
func (va *VoiceAgent) handleForceSubscribeAll(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	roomName := fmt.Sprintf("%s-voice", va.config.RoomPrefix)
	participants, err := va.roomSvc.ListParticipants(r.Context(), &livekit.ListParticipantsRequest{
		Room: roomName,
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("ListParticipants error: %v", err), http.StatusInternalServerError)
		return
	}

	var results []string

	for _, listener := range participants.Participants {
		for _, speaker := range participants.Participants {
			if listener.Identity == speaker.Identity {
				continue
			}
			for _, t := range speaker.Tracks {
				if t.Type == livekit.TrackType_AUDIO {
					_, err := va.roomSvc.UpdateSubscriptions(r.Context(), &livekit.UpdateSubscriptionsRequest{
						Room:      roomName,
						Identity:  listener.Identity,
						TrackSids: []string{t.Sid},
						Subscribe: true,
					})
					msg := fmt.Sprintf("%s -> %s track %s", listener.Identity, speaker.Identity, t.Sid)
					if err != nil {
						msg += fmt.Sprintf(" ERROR: %v", err)
					} else {
						msg += " OK"
					}
					results = append(results, msg)
					log.Println("Force subscribe:", msg)
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"results": results,
	})
}

// proximityLoop periodically checks player distances and updates
// LiveKit track subscriptions accordingly
func (va *VoiceAgent) proximityLoop(ctx context.Context) {
	tickRate := time.Duration(va.config.TickRateMs) * time.Millisecond
	if tickRate <= 0 {
		tickRate = 200 * time.Millisecond
	}

	ticker := time.NewTicker(tickRate)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			va.updateSubscriptions(ctx)
		}
	}
}

// updateSubscriptions computes who should hear whom based on proximity
func (va *VoiceAgent) updateSubscriptions(ctx context.Context) {
	va.mu.RLock()
	// Snapshot positions
	positions := make(map[string]PlayerPosition, len(va.positions))
	for k, v := range va.positions {
		positions[k] = v
	}
	va.mu.RUnlock()

	if len(positions) == 0 {
		return
	}

	rangeSq := va.config.VoiceRange * va.config.VoiceRange
	maxStreams := va.config.MaxStreams
	if maxStreams <= 0 {
		maxStreams = 10
	}

	roomName := fmt.Sprintf("%s-voice", va.config.RoomPrefix)

	// For each listener, determine which speakers should be audible
	for listenerID, listenerPos := range positions {
		type speakerDist struct {
			identity string
			distSq   float64
		}

		var inRange []speakerDist

		for speakerID, speakerPos := range positions {
			if speakerID == listenerID {
				continue
			}

			// Must be in the same world/cell
			if speakerPos.WorldOrCell != listenerPos.WorldOrCell {
				continue
			}

			dx := speakerPos.X - listenerPos.X
			dy := speakerPos.Y - listenerPos.Y
			dz := speakerPos.Z - listenerPos.Z
			distSq := dx*dx + dy*dy + dz*dz

			if distSq <= rangeSq {
				inRange = append(inRange, speakerDist{speakerID, distSq})
			}
		}

		// Sort by distance and cap at maxStreams
		// Simple selection sort since maxStreams is small
		if len(inRange) > maxStreams {
			for i := 0; i < maxStreams; i++ {
				minIdx := i
				for j := i + 1; j < len(inRange); j++ {
					if inRange[j].distSq < inRange[minIdx].distSq {
						minIdx = j
					}
				}
				inRange[i], inRange[minIdx] = inRange[minIdx], inRange[i]
			}
			inRange = inRange[:maxStreams]
		}

		// Build desired subscription set
		desired := make(map[string]bool, len(inRange))
		for _, s := range inRange {
			desired[s.identity] = true
		}

		// Get current subscription state
		va.mu.Lock()
		current, exists := va.subState[listenerID]
		if !exists {
			current = make(map[string]bool)
			va.subState[listenerID] = current
		}
		va.mu.Unlock()

		// Unsubscribe speakers no longer in range
		for speakerID := range current {
			if !desired[speakerID] {
				va.setTrackSubscription(ctx, roomName, listenerID, speakerID, false)
				va.mu.Lock()
				if va.subState[listenerID] != nil {
					delete(va.subState[listenerID], speakerID)
				}
				va.mu.Unlock()
			}
		}

		// Subscribe to new speakers in range
		for speakerID := range desired {
			if !current[speakerID] {
				va.setTrackSubscription(ctx, roomName, listenerID, speakerID, true)
				va.mu.Lock()
				if va.subState[listenerID] == nil {
					va.subState[listenerID] = make(map[string]bool)
				}
				va.subState[listenerID][speakerID] = true
				va.mu.Unlock()
			}
		}
	}
}

// setTrackSubscription subscribes or unsubscribes a listener from
// a speaker's audio tracks via the LiveKit Room Service API
func (va *VoiceAgent) setTrackSubscription(ctx context.Context,
	roomName, listenerID, speakerID string, subscribe bool) {

	// List the speaker's tracks to find their audio track SID
	participants, err := va.roomSvc.ListParticipants(ctx, &livekit.ListParticipantsRequest{
		Room: roomName,
	})
	if err != nil {
		log.Printf("Failed to list participants: %v", err)
		return
	}

	var trackSIDs []string
	for _, p := range participants.Participants {
		if p.Identity == speakerID {
			for _, t := range p.Tracks {
				if t.Type == livekit.TrackType_AUDIO {
					trackSIDs = append(trackSIDs, t.Sid)
				}
			}
		}
	}

	for _, trackSID := range trackSIDs {
		_, err := va.roomSvc.UpdateSubscriptions(ctx, &livekit.UpdateSubscriptionsRequest{
			Room:      roomName,
			Identity:  listenerID,
			TrackSids: []string{trackSID},
			Subscribe: subscribe,
		})
		if err != nil {
			action := "subscribe"
			if !subscribe {
				action = "unsubscribe"
			}
			log.Printf("Failed to %s %s from %s's track: %v",
				action, listenerID, speakerID, err)
		}
	}
}

// distanceBetween computes 3D Euclidean distance
func distanceBetween(a, b PlayerPosition) float64 {
	dx := a.X - b.X
	dy := a.Y - b.Y
	dz := a.Z - b.Z
	return math.Sqrt(dx*dx + dy*dy + dz*dz)
}

func loadConfig() Config {
	config := Config{
		LiveKitHost:   getEnv("LIVEKIT_HOST", "ws://localhost:7880"),
		LiveKitAPIKey: getEnv("LIVEKIT_API_KEY", "devkey"),
		LiveKitSecret: getEnv("LIVEKIT_API_SECRET", "secret"),
		VoiceRange:    4000.0, // ~60m in Skyrim units (1 unit ≈ 1.4cm)
		RoomPrefix:    getEnv("ROOM_PREFIX", "eruvos"),
		TickRateMs:    200,
		MaxStreams:    10,
	}

	// Allow override via config file
	if configPath := os.Getenv("VOICE_AGENT_CONFIG"); configPath != "" {
		data, err := os.ReadFile(configPath)
		if err == nil {
			json.Unmarshal(data, &config)
		}
	}

	return config
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func main() {
	config := loadConfig()

	log.Printf("Voice Agent starting (LiveKit: %s, Range: %.0f)",
		config.LiveKitHost, config.VoiceRange)

	agent := NewVoiceAgent(config)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("Shutting down...")
		cancel()
	}()

	if err := agent.Start(ctx); err != nil {
		log.Fatalf("Voice agent failed: %v", err)
	}
}
