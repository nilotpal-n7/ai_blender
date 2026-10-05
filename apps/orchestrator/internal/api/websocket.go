package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// ─── WebSocket Message Types ────────────────────────────────────────

// Server → Client message types
const (
	MsgSceneUpdated  = "scene:updated"
	MsgJobStatus     = "job:status"
	MsgLayersChanged = "layers:changed"
	MsgError         = "error"
)

// Client → Server message types
const (
	MsgOverridePush   = "override:push"
	MsgSceneSubscribe = "scene:subscribe"
)

// ─── Message Envelope ───────────────────────────────────────────────

// WSMessage is the typed JSON envelope for all WebSocket messages.
type WSMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

// ─── WebSocket Upgrader ─────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true // Accept all origins in development
	},
}

// ─── Constants ──────────────────────────────────────────────────────

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10 // 54s
	maxMessageSize = 1 << 20             // 1 MB
)

// ─── Hub ────────────────────────────────────────────────────────────

// Hub manages WebSocket connections grouped by scene ID.
// It provides fan-out broadcasting to all clients subscribed to a scene.
type Hub struct {
	mu       sync.RWMutex
	scenes   map[string]map[*Client]bool // sceneID → set of clients
	register chan *Client
	remove   chan *Client
}

// NewHub creates a new WebSocket hub.
func NewHub() *Hub {
	return &Hub{
		scenes:   make(map[string]map[*Client]bool),
		register: make(chan *Client),
		remove:   make(chan *Client),
	}
}

// Run starts the hub's main loop for processing register/remove events.
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			if _, ok := h.scenes[client.sceneID]; !ok {
				h.scenes[client.sceneID] = make(map[*Client]bool)
			}
			h.scenes[client.sceneID][client] = true
			count := len(h.scenes[client.sceneID])
			h.mu.Unlock()
			log.Printf("🔌 WS client registered for scene %s (%d clients)", client.sceneID, count)

		case client := <-h.remove:
			h.mu.Lock()
			if clients, ok := h.scenes[client.sceneID]; ok {
				if _, exists := clients[client]; exists {
					delete(clients, client)
					close(client.send)
					if len(clients) == 0 {
						delete(h.scenes, client.sceneID)
					}
				}
			}
			h.mu.Unlock()
			log.Printf("🔌 WS client removed from scene %s", client.sceneID)
		}
	}
}

// BroadcastToScene sends a message to all clients subscribed to a scene.
func (h *Hub) BroadcastToScene(sceneID string, msg WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal WS message: %v", err)
		return
	}

	h.mu.RLock()
	clients, ok := h.scenes[sceneID]
	if !ok {
		h.mu.RUnlock()
		return
	}

	// Copy client list to avoid holding lock during send
	clientList := make([]*Client, 0, len(clients))
	for client := range clients {
		clientList = append(clientList, client)
	}
	h.mu.RUnlock()

	for _, client := range clientList {
		select {
		case client.send <- data:
		default:
			// Client buffer full — schedule removal
			go func(c *Client) {
				h.remove <- c
			}(client)
		}
	}
}

// ─── Client ─────────────────────────────────────────────────────────

// Client represents a single WebSocket connection.
type Client struct {
	hub     *Hub
	conn    *websocket.Conn
	sceneID string
	send    chan []byte
	handler *Handler // Back-reference for handling incoming messages
}

// readPump reads messages from the WebSocket connection.
func (c *Client) readPump() {
	defer func() {
		c.hub.remove <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("WS read error: %v", err)
			}
			break
		}

		var msg WSMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("WS invalid message: %v", err)
			continue
		}

		c.handleMessage(msg)
	}
}

// writePump writes messages to the WebSocket connection.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// handleMessage processes incoming WebSocket messages from the client.
func (c *Client) handleMessage(msg WSMessage) {
	ctx := context.Background()

	switch msg.Type {
	case MsgOverridePush:
		c.handleOverridePush(ctx, msg.Payload)

	case MsgSceneSubscribe:
		c.sendCurrentState(ctx)

	default:
		log.Printf("WS unknown message type: %s", msg.Type)
	}
}

// handleOverridePush processes an override:push message from the viewport.
func (c *Client) handleOverridePush(ctx context.Context, payload interface{}) {
	data, ok := payload.(map[string]interface{})
	if !ok {
		return
	}

	overrideUSDA, ok := data["override_usda"].(string)
	if !ok || overrideUSDA == "" {
		return
	}

	// Push override via scene manager
	if err := c.handler.Scenes.PushOverride(ctx, c.sceneID, overrideUSDA); err != nil {
		log.Printf("WS override push failed for scene %s: %v", c.sceneID, err)
		return
	}

	log.Printf("📝 WS override pushed for scene %s (%d chars)", c.sceneID, len(overrideUSDA))

	// Broadcast layer change to all clients on this scene
	info, _ := c.handler.Scenes.GetLayerInfo(ctx, c.sceneID, false)
	if info != nil {
		c.hub.BroadcastToScene(c.sceneID, WSMessage{
			Type:    MsgLayersChanged,
			Payload: info,
		})
	}
}

// sendCurrentState sends the current scene state to a newly connected client.
func (c *Client) sendCurrentState(ctx context.Context) {
	// Send layer info
	info, err := c.handler.Scenes.GetLayerInfo(ctx, c.sceneID, false)
	if err == nil && info != nil {
		data, _ := json.Marshal(WSMessage{Type: MsgLayersChanged, Payload: info})
		select {
		case c.send <- data:
		default:
		}
	}

	// Send composed USDA
	composed, err := c.handler.Scenes.GetComposed(ctx, c.sceneID)
	if err == nil && composed != "" {
		data, _ := json.Marshal(WSMessage{
			Type: MsgSceneUpdated,
			Payload: map[string]interface{}{
				"scene_id": c.sceneID,
				"usda":     composed,
				"size":     len(composed),
			},
		})
		select {
		case c.send <- data:
		default:
		}
	}
}

// ─── HTTP Handler ───────────────────────────────────────────────────

// ServeWS handles the WebSocket upgrade for GET /ws/scene/:id.
func (h *Handler) ServeWS(c *gin.Context) {
	sceneID := c.Param("id")
	if sceneID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "scene_id required"})
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("WS upgrade failed: %v", err)
		return
	}

	client := &Client{
		hub:     h.Hub,
		conn:    conn,
		sceneID: sceneID,
		send:    make(chan []byte, 256),
		handler: h,
	}

	h.Hub.register <- client

	// Start pumps
	go client.writePump()
	go client.readPump()

	// Send initial state after connection is established
	go func() {
		time.Sleep(100 * time.Millisecond)
		client.sendCurrentState(context.Background())
	}()
}
