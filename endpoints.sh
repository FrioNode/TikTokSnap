# Register a new user (returns API key)
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@test.com","password":"password123", "phone": "1234567890", "label": "Customer Frio"}'

# login (returns API key)
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@test.com","password":"password123"}'

# Update profile (phone and label)
curl -X POST http://localhost:3000/auth/update-profile \
  -H Authorization: Bearer your_jwt_signed_token \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210", "label": "Customer Frio Updated"}'

# Check your profile and usage stats
curl http://localhost:3000/me \
  -H Authorization: Bearer your_jwt_signed_token

# rotate key (invalidates old key immediately)
curl -X POST http://localhost:3000/auth/rotate-key \
  -H Authorization: Bearer your_jwt_signed_token

# change password
curl -X POST http://localhost:3000/auth/change-password \
  -H Authorization: Bearer your_jwt_signed_token \
  -H "Content-Type: application/json" \
  -d '{"current_password": "password123", "new_password": "newpassword456"}'

# Create queue job
curl -X POST http://localhost:3000/download \
  -H "x-api-key: frionode" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.tiktok.com/@graphics475/video/7623866113331629332"}'

# Poll with the jobId you got back
curl http://localhost:3000/job/1 -H "x-api-key: frionode"

# Download when completed
curl http://localhost:3000/file/1 -H "x-api-key: frionode" --output video_name.mp4

# Check queue health anytime
curl http://localhost:3000/queue/stats -H "x-api-key: frionode"

# Check your own usage stats
curl http://localhost:3000/me \
  -H "x-api-key: frionode"

# Admin — see all keys + usage
curl http://localhost:3000/admin/stats \
  -H "x-admin-key: your_secret_admin_key"

# Admin — create a key for a new customer
curl -X POST http://localhost:3000/admin/keys \
  -H "x-admin-key: your_secret_admin_key" \
  -H "Content-Type: application/json" \
  -d '{"label": "Customer John", "plan": "starter"}'

# Admin — revoke a key
curl -X DELETE http://localhost:3000/admin/keys/your_jwt_signed_token \
  -H "x-admin-key: your_secret_admin_key"