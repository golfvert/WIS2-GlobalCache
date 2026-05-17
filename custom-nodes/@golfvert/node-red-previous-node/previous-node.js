module.exports = function(RED) {
    function PreviousNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Initialize counter
        let messageCount = 0;
        
        node.on('input', function(msg, send, done) {
            const currentNodeId = node.id;
            const currentFlowId = node.z;
            
            let previousNodeName = "unknown";
            
            // Find the previous node in the same flow
            RED.nodes.eachNode((n) => {
                if (n.z !== currentFlowId) return;
                
                if (n.wires && n.wires.length > 0) {
                    n.wires.forEach((wireArray) => {
                        if (wireArray && wireArray.includes(currentNodeId)) {
                            previousNodeName = n.name || n.type;
                        }
                    });
                }
            });
            
            // Set only sourceNode
            msg.sourceNode = previousNodeName;
            
            // Increment counter
            messageCount++;
            
            // Update node status with counter
            node.status({
                text: `# ${messageCount}`
            });
            
            send = send || function() { node.send.apply(node, arguments); };
            send(msg);
            
            if (done) done();
        });
        
        // Clear status on close
        node.on('close', function() {
            node.status({});
        });
    }
    
    RED.nodes.registerType("previous-node", PreviousNode);
};
