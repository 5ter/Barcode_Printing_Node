 document.addEventListener('DOMContentLoaded', () => {
            // --- NEW: Read Printer ID from URL Query String ---
            const urlParams = new URLSearchParams(window.location.search);
            // Gets the value of the 'Printer' parameter (e.g., 'A', 'B', or null)
            //eg. http://localhost:3002/?MO=&ActID=&CustID=Awaiting+print+job...&Printer=A
            const urlPrinterId = urlParams.get('Printer'); 
            
            const form = document.getElementById('dataForm');
            const moInput = document.getElementById('MO');
            const actIdInput = document.getElementById('ActID'); 
            const custIdDisplay = document.getElementById('CustID'); 
            const messageDiv = document.getElementById('message');

            /**
             * Resets the display fields to their default or empty state.
             */
            const resetDisplayFields = () => {
                // Reset the display field value
                custIdDisplay.value = 'Awaiting print job...';
            };

            const focusNextInput = () => {
                if (!moInput.value) {
                    // 1. If MO is empty, focus MO.
                    moInput.focus();
                } else if (!actIdInput.value) {
                    // 2. If MO is full and ActID is empty, focus ActID.
                    actIdInput.focus();
                   
                }
                // else {
            // 3. If BOTH are full, clear both and loop back to MO.
                  
                    //moInput.focus(); 
                   // actIdInput.value = '';
               // }
            };
    
            // --- INITIAL AUTOFOCUS WHEN PAGE LOADS ---
                    resetDisplayFields();
                    focusNextInput();

            // --- LOOPING LOGIC: Moves focus to the next input after the current one changes (i.e., after a scan) ---
            
                // When MO changes (after a scan), check the next focus. This will move to ActID.
                moInput.addEventListener('change', focusNextInput);
                
                // When ActID changes (after a scan), check the next focus. This will clear both and loop back to MO.
                actIdInput.addEventListener('change', focusNextInput);

            form.addEventListener('submit', function(event) {
                // *** PREVENT DEFAULT FORM SUBMISSION (PAGE RELOAD) ***
                event.preventDefault();
                
                // Add Bootstrap validation check
                if (!form.checkValidity()) {
                    event.stopPropagation();
                    form.classList.add('was-validated');
                    return;
                }

                // --- RESET FIELDS BEFORE SUBMISSION ---
                resetDisplayFields(); 
                
                // 1. Prepare data for submission 
                const submissionData = {
                    MO: moInput.value,
                    ActID: actIdInput.value,
                    // --- NEW: Include the URL-based printer ID in the payload ---
                    // The server (apps.js) will use this value to select the printer config.
                    printerUrl_id: urlPrinterId 
                };

                // Update the status display *before* the request
                custIdDisplay.value = 'Processing request... Please wait.';
                messageDiv.textContent = `Sending data to server (Printer: ${urlPrinterId || 'Default'})...`;
                form.classList.remove('was-validated'); 

                // Use the fetch API to send a POST request
                fetch('/submit-data', {
                    method: 'POST', 
                    headers: {
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify(submissionData) 
                })
                .then(response => {
                    if (!response.ok) {
                        return response.json().then(errorData => {
                            throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
                        });
                    }
                    return response.json(); 
                })
                .then(data => {
                    // Assuming the server response object 'data' contains a property named 'customerID'
                    const customerIdValue = data.customerID || 'N/A'; 
                    
                    // 2. SUCCESS: Update the CustID display field with the generated value
                    custIdDisplay.value = customerIdValue; 
                    
                    // Display general status/details in the message area
                    const labelContent = data.message.includes(' - ') 
                        ? data.message.split(' - ')[1] 
                        : data.message;
                        
                    messageDiv.innerHTML = `<strong>Print job successful!</strong> Serial: ${data.newSerial}. Generated Label: <code class="text-primary">${labelContent}</code>`;
                })
                .catch(error => {
                    // 3. ERROR: Handle any errors that occurred during the fetch
                    console.error('Error:', error);
                    
                    // Update the CustID field with an error status
                    custIdDisplay.value = `Status: ❌ FAILED!`; 
                    
                    messageDiv.textContent = `Error: ${error.message}`;
                });
            });
        });